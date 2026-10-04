// 先行圧縮の書き出し（区切りごとに書き出す fragmented MP4）を読む：箱をたどって1コマごとの大きさ・時刻・キーフレームの表を作り、切り出し用に1つのファイルにまとめる。画面にも状態にも触らない（Node の単体テストで試せる）

export function boxType(buf, o) { return String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]); }
// buf の [start, end) にある箱を順に fn(type, 中身の始まり, 終わり) で渡す
export function eachBox(buf, dv, start, end, fn) {
  var o = start;
  while (o + 8 <= end) {
    var size = dv.getUint32(o), head = 8;
    if (size === 1) { size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12); head = 16; }
    else if (size === 0) size = end - o;
    if (size < head || o + size > end) return;
    fn(boxType(buf, o + 4), o + head, o + size);
    o += size;
  }
}
// 受け取ったデータの [off, off + len) を写し取る（区切りの書き出しは先頭から順に届く）
export function readChunks(rec, off, len) {
  var out = new Uint8Array(len), got = 0;
  for (var i = rec.parseChunk || 0; i < rec.chunks.length && got < len; i++) {
    var c = rec.chunks[i], cEnd = c.position + c.data.byteLength;
    if (cEnd <= off + got) { rec.parseChunk = i + 1; continue; }
    var from = off + got - c.position, n = Math.min(len - got, c.data.byteLength - from);
    out.set(c.data.subarray(from, from + n), got);
    got += n;
  }
  return got === len ? out : null;
}
// 届いた分の箱を読み進める（moov でトラックの情報を、moof で1コマごとの表を読む）
export function parseFragments(rec) {
  if (!rec.tracks) { rec.tracks = {}; rec.samples = { video: [], audio: [] }; rec.parseOff = 0; }
  while (rec.parseOff + 16 <= rec.bytes) {
    var head = readChunks(rec, rec.parseOff, 16);
    if (!head) return;
    var hv = new DataView(head.buffer), size = hv.getUint32(0), type = boxType(head, 4);
    if (size === 1) size = hv.getUint32(8) * 4294967296 + hv.getUint32(12);
    if (size < 8 || rec.parseOff + size > rec.bytes) return;   // まだ全部届いていない
    if (type === 'moov' || type === 'moof') {
      var buf = readChunks(rec, rec.parseOff, size);
      if (!buf) return;
      var dv = new DataView(buf.buffer);
      if (type === 'moov') parseMoov(rec, buf, dv, size);
      else parseMoof(rec, buf, dv, size);
    }
    rec.parseOff += size;
  }
}
export function parseMoov(rec, buf, dv, size) {
  eachBox(buf, dv, 8, size, function (type, s, e) {
    if (type === 'trak') {
      var t = { timescale: 1000, kind: null, id: 0 };
      eachBox(buf, dv, s, e, function (type2, s2, e2) {
        if (type2 === 'tkhd') t.id = dv.getUint32(s2 + (buf[s2] === 1 ? 20 : 12));
        if (type2 !== 'mdia') return;
        eachBox(buf, dv, s2, e2, function (type3, s3) {
          if (type3 === 'mdhd') t.timescale = dv.getUint32(s3 + (buf[s3] === 1 ? 20 : 12));
          if (type3 === 'hdlr') { var h = boxType(buf, s3 + 8); t.kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : null; }
        });
      });
      rec.tracks[t.id] = Object.assign(rec.tracks[t.id] || {}, t);
    }
    if (type === 'mvex') {
      eachBox(buf, dv, s, e, function (type2, s2) {
        if (type2 !== 'trex') return;
        var id = dv.getUint32(s2 + 4);
        rec.tracks[id] = Object.assign(rec.tracks[id] || {}, {
          defDur: dv.getUint32(s2 + 12), defSize: dv.getUint32(s2 + 16), defFlags: dv.getUint32(s2 + 20)
        });
      });
    }
  });
}
export function parseMoof(rec, buf, dv, size) {
  eachBox(buf, dv, 8, size, function (type, s, e) {
    if (type !== 'traf') return;
    var tr = null, dur = 0, sz = 0, flags = 0, dts = 0;
    eachBox(buf, dv, s, e, function (type2, s2) {
      var f = dv.getUint32(s2) & 0xffffff;
      if (type2 === 'tfhd') {
        tr = rec.tracks[dv.getUint32(s2 + 4)];
        if (!tr) return;
        var o = s2 + 8;
        if (f & 0x1) o += 8;
        if (f & 0x2) o += 4;
        dur = (f & 0x8) ? dv.getUint32(o) : tr.defDur || 0; if (f & 0x8) o += 4;
        sz = (f & 0x10) ? dv.getUint32(o) : tr.defSize || 0; if (f & 0x10) o += 4;
        flags = (f & 0x20) ? dv.getUint32(o) : tr.defFlags || 0;
      } else if (type2 === 'tfdt') {
        dts = buf[s2] === 1 ? dv.getUint32(s2 + 4) * 4294967296 + dv.getUint32(s2 + 8) : dv.getUint32(s2 + 4);
      } else if (type2 === 'trun' && tr && tr.kind) {
        var v1 = buf[s2] === 1, n = dv.getUint32(s2 + 4), o2 = s2 + 8, first = null;
        if (f & 0x1) o2 += 4;
        if (f & 0x4) { first = dv.getUint32(o2); o2 += 4; }
        var list = rec.samples[tr.kind];
        for (var i = 0; i < n; i++) {
          var d = dur, z = sz, fl = i === 0 && first !== null ? first : flags, cts = 0;
          if (f & 0x100) { d = dv.getUint32(o2); o2 += 4; }
          if (f & 0x200) { z = dv.getUint32(o2); o2 += 4; }
          if (f & 0x400) { fl = dv.getUint32(o2); o2 += 4; }
          if (f & 0x800) { cts = v1 ? dv.getInt32(o2) : dv.getUint32(o2); o2 += 4; }
          list.push({ t: (dts + cts) / tr.timescale, d: d / tr.timescale, s: z, k: !(fl & 0x10000) });
          dts += d;
        }
      }
    });
  });
}
// 受け取った書き出しを1つにまとめ、最後の区切りまでで切る（途中で止めたとき、最後の区切りは書きかけのことがある）。
// 区切りごとの書き出しは先頭から順に届くので、受け取ったデータをそのままつなげる（長い動画でも大きな写しを作らない）
export function fragmentsBlob(rec) {
  var chunks = rec.chunks, pos = 0;
  var inOrder = chunks.every(function (c) { var ok = c.position === pos; pos += c.data.byteLength; return ok; });
  if (!inOrder) {
    // 念のため：順に届いていなければ、位置どおりに1つにまとめ直す
    var buf = new Uint8Array(rec.bytes);
    chunks.forEach(function (c) { buf.set(c.data, c.position); });
    chunks = [{ position: 0, data: buf }];
  }
  // 箱（size 4バイト＋種類 4バイト）を先頭から順にたどる
  var ci = 0, total = chunks.reduce(function (n, c) { return n + c.data.byteLength; }, 0);
  function byteAt(off) {
    while (off >= chunks[ci].position + chunks[ci].data.byteLength) ci++;
    while (off < chunks[ci].position) ci--;
    return chunks[ci].data[off - chunks[ci].position];
  }
  var off = 0, keep = 0;
  while (off + 8 <= total) {
    var size = ((byteAt(off) << 24) >>> 0) + (byteAt(off + 1) << 16) + (byteAt(off + 2) << 8) + byteAt(off + 3);
    var type = String.fromCharCode(byteAt(off + 4), byteAt(off + 5), byteAt(off + 6), byteAt(off + 7));
    if (size < 8 || off + size > total) break;
    off += size;
    if (type === 'mdat' || type === 'moov' || type === 'mfra') keep = off;
  }
  return new Blob(chunks.map(function (c) { return c.data; }), { type: 'video/mp4' }).slice(0, keep, 'video/mp4');
}
