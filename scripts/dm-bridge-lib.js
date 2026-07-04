// ═══════════════════════════════════════════════════════════
// 抖音私信 Bridge Lib — 最小化 protobuf 编解码 + DM API 函数
// 注入到页面上下文中运行，使用页面的 fetch/cookie/WebSocket
// ═══════════════════════════════════════════════════════════

// ── 最小化 Protobuf 编解码器 ──
var _DM_PROTO = (function() {
  // Wire types
  var WIRE_VARINT = 0, WIRE_FIXED64 = 1, WIRE_LENDELIM = 2;

  // ═══ Varint 编解码 ═══
  function encodeVarint(val) {
    val = typeof val === 'bigint' ? Number(val) : (val | 0);
    if (val < 0) val = val >>> 0; // 转为无符号
    var bytes = [];
    do {
      var b = val & 0x7F;
      val = val >>> 7;
      if (val) b |= 0x80;
      bytes.push(b);
    } while (val);
    return bytes;
  }

  function encodeVarintBig(val) {
    if (val === undefined || val === null || val === '') return [0];
    try { val = BigInt(val); } catch(e) { return [0]; }
    var bytes = [];
    while (val > 127n) {
      bytes.push(Number(val & 127n) | 128);
      val = val >> 7n;
    }
    bytes.push(Number(val));
    return bytes;
  }

  function decodeVarint(bytes, offset) {
    var result = 0n, shift = 0n, pos = offset || 0;
    while (pos < bytes.length) {
      var b = BigInt(bytes[pos++]);
      result |= (b & 127n) << shift;
      if (!(b & 128n)) break;
      shift += 7n;
    }
    return { value: result, nextPos: pos };
  }

  // ═══ 字段编码 ═══
  function encodeTag(fieldNum, wireType) {
    return encodeVarint((fieldNum << 3) | wireType);
  }

  function encodeUint64Field(fieldNum, val) {
    return encodeTag(fieldNum, WIRE_VARINT).concat(encodeVarintBig(val));
  }

  function encodeIntField(fieldNum, val) {
    return encodeTag(fieldNum, WIRE_VARINT).concat(encodeVarint(val));
  }

  function encodeStringField(fieldNum, val) {
    var utf8 = stringToUTF8(val);
    return encodeTag(fieldNum, WIRE_LENDELIM)
      .concat(encodeVarint(utf8.length))
      .concat(utf8);
  }

  function encodeBytesField(fieldNum, val) {
    return encodeTag(fieldNum, WIRE_LENDELIM)
      .concat(encodeVarint(val.length))
      .concat(Array.from(val));
  }

  function encodeMessageField(fieldNum, msgBytes) {
    return encodeTag(fieldNum, WIRE_LENDELIM)
      .concat(encodeVarint(msgBytes.length))
      .concat(msgBytes);
  }

  function encodeBoolField(fieldNum, val) {
    return encodeTag(fieldNum, WIRE_VARINT).concat(val ? [1] : [0]);
  }

  function encodeRepeatedInt64(fieldNum, arr) {
    var bytes = [];
    for (var i = 0; i < arr.length; i++) {
      bytes = bytes.concat(encodeTag(fieldNum, WIRE_VARINT)).concat(encodeVarintBig(arr[i]));
    }
    return bytes;
  }

  function encodeMapStringField(fieldNum, obj) {
    var bytes = [];
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var entry = encodeStringField(1, keys[i]).concat(encodeStringField(2, obj[keys[i]]));
      bytes = bytes.concat(encodeMessageField(fieldNum, entry));
    }
    return bytes;
  }

  function encodeMapStringStringField(fieldNum, obj) {
    // map<string,string> 编码为 repeated message { key=1, value=2 }
    var bytes = [];
    var keys = Object.keys(obj || {});
    for (var i = 0; i < keys.length; i++) {
      var entry = encodeStringField(1, keys[i]).concat(encodeStringField(2, String(obj[keys[i]])));
      bytes = bytes.concat(encodeMessageField(fieldNum, entry));
    }
    return bytes;
  }

  // ═══ UTF-8 编解码 ═══
  function stringToUTF8(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0xD800 || c >= 0xE000) {
        bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        // Surrogate pair
        i++;
        var c2 = str.charCodeAt(i);
        var cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
        bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                   0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return bytes;
  }

  function utf8ToString(bytes, offset, length) {
    var str = '', end = (offset || 0) + (length || bytes.length);
    for (var i = offset || 0; i < end;) {
      var b = bytes[i++];
      if (b < 0x80) {
        str += String.fromCharCode(b);
      } else if (b < 0xE0) {
        str += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
      } else if (b < 0xF0) {
        str += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i] & 0x3F) << 6) | (bytes[i+1] & 0x3F));
        i += 2;
      } else {
        var cp = ((b & 0x07) << 18) | ((bytes[i] & 0x3F) << 12) | ((bytes[i+1] & 0x3F) << 6) | (bytes[i+2] & 0x3F);
        cp -= 0x10000;
        str += String.fromCharCode(0xD800 + (cp >> 10));
        str += String.fromCharCode(0xDC00 + (cp & 0x3FF));
        i += 3;
      }
    }
    return str;
  }

  // ═══ 字段解码 ═══
  function decodeField(bytes, offset) {
    var tag = decodeVarint(bytes, offset);
    var fieldNum = Number(tag.value >> 3n);
    var wireType = Number(tag.value & 7n);
    var result = { fieldNum: fieldNum, wireType: wireType };
    var pos = tag.nextPos;

    if (wireType === WIRE_VARINT) {
      var v = decodeVarint(bytes, pos);
      result.value = v.value;
      pos = v.nextPos;
    } else if (wireType === WIRE_FIXED64) {
      result.value = bytes.slice(pos, pos + 8);
      pos += 8;
    } else if (wireType === WIRE_LENDELIM) {
      var len = decodeVarint(bytes, pos);
      var dataStart = len.nextPos;
      var dataLen = Number(len.value);
      result.value = bytes.slice(dataStart, dataStart + dataLen);
      pos = dataStart + dataLen;
    }
    return { field: result, nextPos: pos };
  }

  // ═══ 具体消息编解码 ═══

  // 编码 Request 消息
  // @param {object} opts
  // @param {number} opts.cmd - 100=发送消息, 609=创建会话, 610=获取会话列表
  // @param {string} opts.token - web_protect ticket
  // @param {string} opts.ts_sign - web_protect ts_sign
  // @param {string} opts.sdk_cert - base64(client_cert)
  // @param {string} opts.reuqest_sign - ECDSA 签名
  // @param {object} opts.body - 内层消息体字节
  // @param {object} opts.headersObj - 请求头 map
  function encodeRequest(opts) {
    var bodyBytes = opts.bodyBytes || [];
    var bodyFieldNum = 0;
    if (opts.cmd === 100) bodyFieldNum = 100;      // send_message_body
    else if (opts.cmd === 609) bodyFieldNum = 609;  // create_conversation_v2_body
    else if (opts.cmd === 610) bodyFieldNum = 610;  // get_conversation_info_list_v2_body

    var bytes = [].concat(
      encodeIntField(1, opts.cmd),                                      // cmd
      encodeIntField(2, opts.sequence_id || (10000 + Math.floor(Math.random()*1000))), // sequence_id
      encodeStringField(3, opts.sdk_version || '1.1.3'),                // sdk_version
      encodeStringField(4, opts.token || ''),                           // token
      encodeIntField(5, opts.refer || 3),                               // refer
      encodeIntField(6, opts.inbox_type || 0),                          // inbox_type
      encodeStringField(7, opts.build_number || '5fa6ff1:Detached: 5fa6ff1111fd53aafc4c753505d3c93daad74d27'),
      encodeMessageField(8, bodyBytes),                                  // body
      encodeStringField(9, opts.device_id || '0'),                      // device_id
      encodeStringField(11, opts.device_platform || 'douyin_pc'),       // device_platform
      encodeMapStringStringField(15, opts.headersObj || {
        session_aid: '6383', session_did: '0', app_name: 'douyin_pc',
        priority_region: 'cn', cookie_enabled: 'true',
        browser_language: 'zh-CN', browser_platform: 'Win32',
        browser_online: 'true', screen_width: String(screen.width),
        screen_height: String(screen.height),
        user_agent: navigator.userAgent,
        referer: '', timezone_name: 'Etc/GMT-8',
        deviceId: '0', webid: (typeof getCookie==='function' ? getCookie('s_v_web_id') : '') || '',
        fp: (typeof getCookie==='function' ? getCookie('s_v_web_id') : '') || ''
      }),
      encodeIntField(18, opts.auth_type || 4),                          // auth_type
      encodeStringField(21, opts.biz || 'douyin_web'),                  // biz
      encodeStringField(22, opts.access || 'web_sdk'),                  // access
      encodeStringField(23, opts.ts_sign || ''),                        // ts_sign
      encodeStringField(24, opts.sdk_cert || ''),                       // sdk_cert
      encodeStringField(25, opts.reuqest_sign || '')                     // reuqest_sign
    );
    return bytes;
  }

  // 编码 SendMessageRequestBody
  function encodeSendMessageBody(opts) {
    var content = JSON.stringify({
      mention_users: [],
      aweType: 700,
      richTextInfos: [],
      text: opts.text || ''
    });

    var extBytes = [].concat(
      encodeExtValue('s:client_message_id', opts.client_message_id || ''),
      encodeExtValue('s:stime', String(Date.now())),
      encodeExtValue('s:mentioned_users', '')
    );

    var bytes = [].concat(
      encodeStringField(1, opts.conversation_id),
      encodeIntField(2, opts.conversation_type || 1),
      encodeIntField(3, opts.conversation_short_id || 0),
      encodeStringField(4, content),
      extBytes,
      encodeIntField(6, opts.message_type || 7),
      encodeStringField(7, opts.ticket || ''),
      encodeStringField(8, opts.client_message_id || '')
    );
    return bytes;
  }

  function encodeExtValue(key, value) {
    return encodeMessageField(5, encodeStringField(1, key).concat(encodeStringField(2, value)));
  }

  // 编码 CreateConversationV2RequestBody
  function encodeCreateConversationBody(opts) {
    var bytes = [].concat(
      encodeIntField(1, opts.conversation_type || 1),
      encodeRepeatedInt64(2, opts.participants || [])
    );
    return bytes;
  }

  // 解码 PushFrame (WebSocket 接收)
  function decodePushFrame(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;
      switch (f.fieldNum) {
        case 1: result.seqId = f.value; break;
        case 2: result.logId = f.value; break;
        case 7: result.payloadType = utf8ToString(f.value); break;
        case 8: result.payload = f.value; break;
      }
    }
    return result;
  }

  // 解码 Response 消息
  function decodeResponse(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      if (f.fieldNum === 6 && f.wireType === WIRE_LENDELIM) {
        // ResponseBody — 递归解码
        result.body = decodeResponseBody(f.value);
      } else if (f.fieldNum === 1) {
        result.cmd = Number(f.value);
      } else if (f.fieldNum === 2) {
        result.sequence_id = f.value;
      } else if (f.fieldNum === 3) {
        result.error_desc = utf8ToString(f.value);
      } else if (f.fieldNum === 4) {
        result.message = utf8ToString(f.value);
      }
    }
    return result;
  }

  function decodeResponseBody(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      if (f.fieldNum === 500 && f.wireType === WIRE_LENDELIM) {
        result.new_message_notify = decodeNewMessageNotify(f.value);
      } else if (f.fieldNum === 609 && f.wireType === WIRE_LENDELIM) {
        result.create_conversation_v2_body = decodeConversationList(f.value);
      } else if (f.fieldNum === 610 && f.wireType === WIRE_LENDELIM) {
        result.get_conversation_info_list_v2_response_body = decodeConversationList(f.value);
      }
    }
    return result;
  }

  function decodeNewMessageNotify(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      if (f.fieldNum === 5 && f.wireType === WIRE_LENDELIM) {
        result.message = decodeMessageBody(f.value);
      } else if (f.fieldNum === 2) {
        result.conversation_id = utf8ToString(f.value);
      } else if (f.fieldNum === 3) {
        result.conversation_type = Number(f.value);
      }
    }
    return result;
  }

  function decodeMessageBody(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      switch (f.fieldNum) {
        case 1: result.conversation_id = utf8ToString(f.value); break;
        case 4: result.index_in_conversation = f.value; break;
        case 5: result.conversation_short_id = f.value; break;
        case 6: result.message_type = Number(f.value); break;
        case 7: result.sender = f.value; break;
        case 8: result.content = utf8ToString(f.value); break;
      }
    }
    // 解析 content JSON
    if (result.content) {
      try { result.content_parsed = JSON.parse(result.content); } catch(e) {}
    }
    return result;
  }

  function decodeConversationList(bytes) {
    var result = { conversation_info_list: [] }, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      if (f.fieldNum === 1 && f.wireType === WIRE_LENDELIM) {
        result.conversation_info_list.push(decodeConversationInfo(f.value));
      }
    }
    return result;
  }

  function decodeConversationInfo(bytes) {
    var result = {}, pos = 0;
    while (pos < bytes.length) {
      var decoded = decodeField(bytes, pos);
      var f = decoded.field;
      pos = decoded.nextPos;

      switch (f.fieldNum) {
        case 1: result.conversation_id = utf8ToString(f.value); break;
        case 2: result.conversation_short_id = f.value; break;
        case 3: result.conversation_type = Number(f.value); break;
        case 4: result.ticket = utf8ToString(f.value); break;
      }
    }
    return result;
  }

  return {
    encodeRequest: encodeRequest,
    encodeSendMessageBody: encodeSendMessageBody,
    encodeCreateConversationBody: encodeCreateConversationBody,
    decodePushFrame: decodePushFrame,
    decodeResponse: decodeResponse,
    bytesToArray: function(bytes) { return new Uint8Array(bytes); }
  };
})();


// ── DM 辅助函数 ──
var _DM_HELPERS = (function() {
  // 从 localStorage 读取 web_protect 和 SDK 密钥
  // 注意: 抖音实际使用的 key 可能有变体，做 fallback
  function getDMKeys() {
    // 尝试多种可能的 localStorage key
    var wpRaw = null;
    var sdkRaw = null;

    try { wpRaw = localStorage.getItem('web_protect'); } catch(e) {}
    if (!wpRaw) {
      try { wpRaw = localStorage.getItem('security-sdk/s_sdk_sign_data_key/web_protect'); } catch(e) {}
    }

    try { sdkRaw = localStorage.getItem('s_sdk_crypt_sdk'); } catch(e) {}
    if (!sdkRaw) {
      try { sdkRaw = localStorage.getItem('security-sdk/s_sdk_crypt_sdk'); } catch(e) {}
    }
    // 旧版 key
    if (!sdkRaw) {
      try { sdkRaw = localStorage.getItem('bd_ec_key'); } catch(e) {}
    }

    var wp = {}, sdk = {};
    if (wpRaw) {
      try { wp = JSON.parse(wpRaw); } catch(e) {}
      // 有时 web_protect 有多层 JSON 嵌套
      if (wp.data && typeof wp.data === 'string') {
        try { wp = JSON.parse(wp.data); } catch(e2) {}
      } else if (wp.data && typeof wp.data === 'object') {
        wp = wp.data;
      }
    }
    if (sdkRaw) {
      try { sdk = JSON.parse(sdkRaw); } catch(e) {}
      if (sdk.data && typeof sdk.data === 'string') {
        try { sdk = JSON.parse(sdk.data); } catch(e2) {}
      } else if (sdk.data && typeof sdk.data === 'object') {
        sdk = sdk.data;
      }
    }

    return {
      ticket: wp.ticket || '',
      ts_sign: wp.ts_sign || '',
      client_cert: wp.client_cert || '',
      privateKey: sdk.ec_privateKey || '',
      publicKey: sdk.ec_publicKey || ''
    };
  }

  // ECDSA SHA256 签名 (使用 Web Crypto API)
  async function ecdsaSign(privateKeyHex, dataToSign) {
    if (!privateKeyHex || !dataToSign) return '';
    try {
      // EC 私钥 hex → ArrayBuffer
      var keyBytes = hexToArrayBuffer(privateKeyHex);
      // 导入为 ECDSA P-256 密钥
      var key = await crypto.subtle.importKey(
        'raw', keyBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign']
      );
      // SHA-256 哈希 + 签名
      var dataBytes = new TextEncoder().encode(dataToSign);
      var signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key, dataBytes
      );
      // 转为 base64
      return arrayBufferToBase64(signature);
    } catch(e) {
      console.warn('[DM] ECDSA sign failed:', e.message);
      return '';
    }
  }

  function hexToArrayBuffer(hex) {
    hex = hex.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) hex = '0' + hex;
    var len = hex.length / 2;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) {
      view[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return buf;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // 生成 msToken (107 随机字符)
  function generateMsToken() {
    var chars = 'ABCDEFGHIGKLMNOPQRSTUVWXYZabcdefghigklmnopqrstuvwxyz0123456789=';
    var arr = new Uint8Array(107);
    crypto.getRandomValues(arr);
    var result = '';
    for (var i = 0; i < 107; i++) {
      result += chars[arr[i] % chars.length];
    }
    return result;
  }

  // 计算 DM WebSocket access_key
  function computeAccessKey(deviceId, fpid, appKey) {
    var raw = (fpid || '9') + (appKey || 'e1bd35ec9db7b8d846de66ed140b1ad9') + deviceId + 'f8a69f1719916z';
    // MD5 — 使用浏览器原生 crypto API (如果支持) 否则用简化方法
    // 注意: crypto.subtle.digest 是异步的，这里我们需要同步方法
    // 使用简单的 hash (生产环境应使用完整 MD5)
    // 由于浏览器限制，暂时用简单的 XOR hash 作为占位
    // 实际使用时需要引入 MD5 实现或使用 crypto.subtle
    return md5(raw);
  }

  // 简单 MD5 实现 (用于 access_key 计算)
  function md5(string) {
    function rotateLeft(lValue, iShiftBits) {
      return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
    }
    function addUnsigned(lX, lY) {
      var lX4, lY4, lX8, lY8, lResult;
      lX8 = (lX & 0x80000000);
      lY8 = (lY & 0x80000000);
      lX4 = (lX & 0x40000000);
      lY4 = (lY & 0x40000000);
      lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
      if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
      if (lX4 | lY4) {
        if (lResult & 0x40000000) return lResult ^ 0xC0000000 ^ lX8 ^ lY8;
        else return lResult ^ 0x40000000 ^ lX8 ^ lY8;
      } else return lResult ^ lX8 ^ lY8;
    }
    function F(x, y, z) { return (x & y) | ((~x) & z); }
    function G(x, y, z) { return (x & z) | (y & (~z)); }
    function H(x, y, z) { return x ^ y ^ z; }
    function I(x, y, z) { return y ^ (x | (~z)); }
    function FF(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function GG(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function HH(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function II(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function convertToWordArray(string) {
      var lWordCount, lMessageLength = string.length, lNumberOfWords_temp1 = lMessageLength + 8,
          lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64,
          lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16,
          lWordArray = Array(lNumberOfWords - 1), lBytePosition = 0, lByteCount = 0;
      while (lByteCount < lMessageLength) {
        lWordCount = (lByteCount - (lByteCount % 4)) / 4;
        lBytePosition = (lByteCount % 4) * 8;
        lWordArray[lWordCount] = (lWordArray[lWordCount] | (string.charCodeAt(lByteCount) << lBytePosition));
        lByteCount++;
      }
      lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
      lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
      lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
      return lWordArray;
    }
    function wordToHex(lValue) {
      var wordToHexValue = '', wordToHexValue_temp = '', lByte, lCount;
      for (lCount = 0; lCount <= 3; lCount++) {
        lByte = (lValue >>> (lCount * 8)) & 255;
        wordToHexValue_temp = '0' + lByte.toString(16);
        wordToHexValue = wordToHexValue + wordToHexValue_temp.substr(wordToHexValue_temp.length - 2, 2);
      }
      return wordToHexValue;
    }
    var x = convertToWordArray(string);
    var a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    for (var k = 0; k < x.length; k += 16) {
      var AA = a, BB = b, CC = c, DD = d;
      a = FF(a, b, c, d, x[k+0],  7,  0xD76AA478);
      d = FF(d, a, b, c, x[k+1],  12, 0xE8C7B756);
      c = FF(c, d, a, b, x[k+2],  17, 0x242070DB);
      b = FF(b, c, d, a, x[k+3],  22, 0xC1BDCEEE);
      a = FF(a, b, c, d, x[k+4],  7,  0xF57C0FAF);
      d = FF(d, a, b, c, x[k+5],  12, 0x4787C62A);
      c = FF(c, d, a, b, x[k+6],  17, 0xA8304613);
      b = FF(b, c, d, a, x[k+7],  22, 0xFD469501);
      a = FF(a, b, c, d, x[k+8],  7,  0x698098D8);
      d = FF(d, a, b, c, x[k+9],  12, 0x8B44F7AF);
      c = FF(c, d, a, b, x[k+10], 17, 0xFFFF5BB1);
      b = FF(b, c, d, a, x[k+11], 22, 0x895CD7BE);
      a = FF(a, b, c, d, x[k+12], 7,  0x6B901122);
      d = FF(d, a, b, c, x[k+13], 12, 0xFD987193);
      c = FF(c, d, a, b, x[k+14], 17, 0xA679438E);
      b = FF(b, c, d, a, x[k+15], 22, 0x49B40821);
      a = GG(a, b, c, d, x[k+1],  5,  0xF61E2562);
      d = GG(d, a, b, c, x[k+6],  9,  0xC040B340);
      c = GG(c, d, a, b, x[k+11], 14, 0x265E5A51);
      b = GG(b, c, d, a, x[k+0],  20, 0xE9B6C7AA);
      a = GG(a, b, c, d, x[k+5],  5,  0xD62F105D);
      d = GG(d, a, b, c, x[k+10], 9,  0x02441453);
      c = GG(c, d, a, b, x[k+15], 14, 0xD8A1E681);
      b = GG(b, c, d, a, x[k+4],  20, 0xE7D3FBC8);
      a = GG(a, b, c, d, x[k+9],  5,  0x21E1CDE6);
      d = GG(d, a, b, c, x[k+14], 9,  0xC33707D6);
      c = GG(c, d, a, b, x[k+3],  14, 0xF4D50D87);
      b = GG(b, c, d, a, x[k+8],  20, 0x455A14ED);
      a = GG(a, b, c, d, x[k+13], 5,  0xA9E3E905);
      d = GG(d, a, b, c, x[k+2],  9,  0xFCEFA3F8);
      c = GG(c, d, a, b, x[k+7],  14, 0x676F02D9);
      b = GG(b, c, d, a, x[k+12], 20, 0x8D2A4C8A);
      a = HH(a, b, c, d, x[k+5],  4,  0xFFFA3942);
      d = HH(d, a, b, c, x[k+8],  11, 0x8771F681);
      c = HH(c, d, a, b, x[k+11], 16, 0x6D9D6122);
      b = HH(b, c, d, a, x[k+14], 23, 0xFDE5380C);
      a = HH(a, b, c, d, x[k+1],  4,  0xA4BEEA44);
      d = HH(d, a, b, c, x[k+4],  11, 0x4BDECFA9);
      c = HH(c, d, a, b, x[k+7],  16, 0xF6BB4B60);
      b = HH(b, c, d, a, x[k+10], 23, 0xBEBFBC70);
      a = HH(a, b, c, d, x[k+13], 4,  0x289B7EC6);
      d = HH(d, a, b, c, x[k+0],  11, 0xEAA127FA);
      c = HH(c, d, a, b, x[k+3],  16, 0xD4EF3085);
      b = HH(b, c, d, a, x[k+6],  23, 0x04881D05);
      a = HH(a, b, c, d, x[k+9],  4,  0xD9D4D039);
      d = HH(d, a, b, c, x[k+12], 11, 0xE6DB99E5);
      c = HH(c, d, a, b, x[k+15], 16, 0x1FA27CF8);
      b = HH(b, c, d, a, x[k+2],  23, 0xC4AC5665);
      a = II(a, b, c, d, x[k+0],  6,  0xF4292244);
      d = II(d, a, b, c, x[k+7],  10, 0x432AFF97);
      c = II(c, d, a, b, x[k+14], 15, 0xAB9423A7);
      b = II(b, c, d, a, x[k+5],  21, 0xFC93A039);
      a = II(a, b, c, d, x[k+12], 6,  0x655B59C3);
      d = II(d, a, b, c, x[k+3],  10, 0x8F0CCC92);
      c = II(c, d, a, b, x[k+10], 15, 0xFFEFF47D);
      b = II(b, c, d, a, x[k+1],  21, 0x85845DD1);
      a = II(a, b, c, d, x[k+8],  6,  0x6FA87E4F);
      d = II(d, a, b, c, x[k+15], 10, 0xFE2CE6E0);
      c = II(c, d, a, b, x[k+6],  15, 0xA3014314);
      b = II(b, c, d, a, x[k+13], 21, 0x4E0811A1);
      a = II(a, b, c, d, x[k+4],  6,  0xF7537E82);
      d = II(d, a, b, c, x[k+11], 10, 0xBD3AF235);
      c = II(c, d, a, b, x[k+2],  15, 0x2AD7D2BB);
      b = II(b, c, d, a, x[k+9],  21, 0xEB86D391);
      a = addUnsigned(a, AA);
      b = addUnsigned(b, BB);
      c = addUnsigned(c, CC);
      d = addUnsigned(d, DD);
    }
    return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
  }

  // 获取 deviceId (用于 WebSocket)
  function getDeviceId() {
    try {
      return (localStorage.getItem('d_device_id') || localStorage.getItem('device_id')
              || getCookie('device_id') || '0');
    } catch(e) { return '0'; }
  }

  return {
    getDMKeys: getDMKeys,
    ecdsaSign: ecdsaSign,
    generateMsToken: generateMsToken,
    computeAccessKey: computeAccessKey,
    getDeviceId: getDeviceId,
    md5: md5
  };
})();
