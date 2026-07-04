  // ── 私信 (DM) ──
  _dmKeys: function(){ return _DM_HELPERS.getDMKeys(); },
  _myUidCache: null,
  _getMyUid: async function(){
    if(window.__bridge._myUidCache)return window.__bridge._myUidCache;
    // 从 myPosts 的 user info API 获取
    try{
      var p=new URLSearchParams(Object.assign(this._q(),{}));
      var info=await bridgeFetchJson('getMyUid','/aweme/v1/web/query/user/?'+p,{credentials:'include'},true);
      var uid=(info.user||{}).uid||(info.user||{}).short_id||'';
      if(uid){window.__bridge._myUidCache=String(uid);return uid;}
    }catch(e){console.warn('[DM] getMyUid failed:',e.message);}
    // fallback: 从 cookie 或 localStorage 取
    var id=getCookie('uid')||getCookie('UIFID')||'';
    if(id&&id.length>=3)return id;
    try{var ui=JSON.parse(localStorage.getItem('user_info')||'{}');id=ui.short_id||ui.user_id||ui.uid||'';}catch(e){}
    if(id&&id.length>=3&&id.length<20)return id;
    return '';
  },
  createConversation: async function(toUserId){
    var keys=_DM_HELPERS.getDMKeys();
    var myUid=await this._getMyUid();
    if(!myUid)throw new Error('无法获取当前登录用户的ID，请确认已登录抖音');
    var bodyBytes=_DM_PROTO.encodeCreateConversationBody({conversation_type:1,participants:[toUserId,myUid]});
    var signData='avatar_url=&idempotent_id=&name=&participants='+toUserId+','+myUid;
    var reqSign=await _DM_HELPERS.ecdsaSign(keys.privateKey,signData);
    var requestBytes=_DM_PROTO.encodeRequest({cmd:609,token:keys.ticket,ts_sign:keys.ts_sign,
      sdk_cert:btoa(keys.client_cert||''),reuqest_sign:reqSign,bodyBytes:bodyBytes});
    var resp=await fetch('https://imapi.douyin.com/v2/conversation/create',{
      method:'POST',headers:{'Content-Type':'application/x-protobuf','Accept':'application/x-protobuf'},
      body:_DM_PROTO.bytesToArray(requestBytes),credentials:'include'});
    if(!resp.ok){var t=await resp.text();throw new Error('[createConversation] HTTP '+resp.status+': '+t.substring(0,200));}
    var respBytes=new Uint8Array(await resp.arrayBuffer());
    var result=_DM_PROTO.decodeResponse(respBytes);
    if(result.body&&result.body.create_conversation_v2_body){
      var cl=result.body.create_conversation_v2_body.conversation_info_list||[];
      if(cl.length>0)return{conversation_id:cl[0].conversation_id,
        conversation_short_id:String(cl[0].conversation_short_id),ticket:cl[0].ticket};
    }
    throw new Error('[createConversation] 未找到会话: '+JSON.stringify(result).substring(0,200));
  },
  sendDM: async function(convId,text){
    var parts=convId.split('|');
    var conversation_id=parts[0],conversation_short_id=parts[1]||'0',ticket=parts[2]||'';
    var keys=_DM_HELPERS.getDMKeys();
    var clientMsgId=Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    var bodyBytes=_DM_PROTO.encodeSendMessageBody({conversation_id:conversation_id,
      conversation_short_id:conversation_short_id,conversation_type:1,ticket:ticket,
      text:text,client_message_id:clientMsgId,message_type:7});
    var contentJson=JSON.stringify({mention_users:[],aweType:700,richTextInfos:[],text:text});
    var signData='content='+contentJson+'&conversation_id='+conversation_id+'&conversation_short_id='+conversation_short_id;
    var reqSign=await _DM_HELPERS.ecdsaSign(keys.privateKey,signData);
    var requestBytes=_DM_PROTO.encodeRequest({cmd:100,token:keys.ticket,ts_sign:keys.ts_sign,
      sdk_cert:btoa(keys.client_cert||''),reuqest_sign:reqSign,bodyBytes:bodyBytes});
    var resp=await fetch('https://imapi.douyin.com/v1/message/send',{
      method:'POST',headers:{'Content-Type':'application/x-protobuf','Accept':'application/x-protobuf'},
      body:_DM_PROTO.bytesToArray(requestBytes),credentials:'include'});
    if(!resp.ok){var t=await resp.text();throw new Error('[sendDM] HTTP '+resp.status+': '+t.substring(0,200));}
    var respBytes=new Uint8Array(await resp.arrayBuffer());
    return _DM_PROTO.decodeResponse(respBytes);
  },
  connectDMWS: function(){
    if(window.__dmWs&&window.__dmWs.readyState===WebSocket.OPEN)return{status:'connected'};
    // 获取真实 device_id: 优先取 cookie 中的 uid，然后尝试多种 localStorage key
    var deviceId=getCookie('uid')||getCookie('UIFID')||
      localStorage.getItem('d_device_id')||localStorage.getItem('device_id')||
      localStorage.getItem('user_unique_id')||'0';
    if(deviceId==='0'){
      try{var s=localStorage.getItem('bd_ticket_guard_client_data');if(s){var j=JSON.parse(s);deviceId=j.user_id||'0';}}catch(e){}
    }
    // 匹配抖音原生 IM WebSocket 参数
    var accessKey=_DM_HELPERS.computeAccessKey(deviceId,'9','e1bd35ec9db7b8d846de66ed140b1ad9');
    var p=new URLSearchParams({aid:'6383',device_platform:'web',fpid:'9',
      version_code:'fws_1.0.0',device_id:deviceId,access_key:accessKey,
      xsack:'0',xaack:'0',xsqos:'0',qos_sdk_version:'2'});
    try{
      var ws=new WebSocket('wss://frontier-im.douyin.com/ws/v2?'+p.toString());
      ws.binaryType='arraybuffer';
      ws.onopen=function(){console.log('[DM WS] Connected');window.__dmWs=ws;};
      ws.onmessage=function(event){
        try{
          var mbytes=new Uint8Array(event.data);
          var frame=_DM_PROTO.decodePushFrame(mbytes);
          if(frame.payloadType==='pb'&&frame.payload){
            var resp=_DM_PROTO.decodeResponse(frame.payload);
            if(resp.body&&resp.body.new_message_notify){
              var msg=resp.body.new_message_notify.message;
              window.__dmQueue=window.__dmQueue||[];
              window.__dmQueue.push({sender:String(msg.sender),
                conversation_id:msg.conversation_id,message_type:msg.message_type,
                content:msg.content_parsed||msg.content,
                index:String(msg.index_in_conversation),timestamp:Date.now()});
            }
          }
        }catch(e){console.warn('[DM WS] Decode:',e.message);}
      };
      ws.onclose=function(){console.log('[DM WS] Closed');setTimeout(function(){window.__bridge.connectDMWS();},5000);};
      ws.onerror=function(){console.warn('[DM WS] Error');};
      return{status:'connecting'};
    }catch(e){console.warn('[DM WS] Failed:',e.message);return{status:'error',error:e.message};}
  },
  pollDMs: async function(timeoutMs){
    var deadline=Date.now()+(timeoutMs||30000);
    window.__dmQueue=window.__dmQueue||[];
    this.connectDMWS();
    while(Date.now()<deadline){
      if(window.__dmQueue.length>0)return{messages:window.__dmQueue.splice(0),has_more:false};
      await new Promise(function(r){setTimeout(r,500);});
    }
    return{messages:[],has_more:false};
  },
  getDMs: function(){
    window.__dmQueue=window.__dmQueue||[];
    return window.__dmQueue.splice(0);
  },
