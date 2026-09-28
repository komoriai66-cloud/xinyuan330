// ============================================================
// tts-audio.js — TTS 语音播放、真实录音播放、双语翻译
// 来源：script.js 第 53313 ~ 53978 行
// ============================================================

  function playSilentAudio() {
    const silentPlayer = document.getElementById('silent-audio-player');
    if (silentPlayer) {

      const playPromise = silentPlayer.play();
      if (playPromise !== undefined) {
        playPromise.then(_ => {
          console.log("静音音频已启动，用于后台活动保活。");
        }).catch(error => {


          console.warn("无法自动播放静音音频（这在iOS首次加载时是正常现象）:", error);
        });
      }
    }
  }


  function stopSilentAudio() {
    const silentPlayer = document.getElementById('silent-audio-player');
    if (silentPlayer && !silentPlayer.paused) {
      silentPlayer.pause();
      silentPlayer.currentTime = 0;
      console.log("静音音频已停止。");
    }
  }


  function hexToUint8Array(hexString) {
    if (!hexString) return new Uint8Array();
    const arrayBuffer = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      arrayBuffer[i / 2] = parseInt(hexString.substr(i, 2), 16);
    }
    return arrayBuffer;
  }
  // --- TTS 播放队列（修复：前一条没读完就跳到最后一条的问题） ---
  const ttsQueue = [];
  let isTtsPlaying = false;

  // 参考并改写自 yxlforever/YYY：
  // https://github.com/yxlforever/YYY/commit/ece2d6bec633ced55c89af3871f96c97ebf3aa7e
  // 用途：限制仅用于加速播放的临时 TTS 内存缓存，并确保 Blob URL、请求与 FileReader 可释放。
  // 本实现不删除聊天、语音消息或任何持久化用户数据，也不改变原有 TTS 入口与配置。
  const TTS_CACHE_MAX = 15;
  let currentCallTtsObjectUrl = null;
  let currentChatTtsObjectUrl = null;
  let callTtsAbortController = null;
  let callTtsGeneration = 0;
  let chatTtsGeneration = 0;
  let activeTtsCacheReader = null;

  function revokeCallTtsUrl() {
    if (!currentCallTtsObjectUrl) return;
    try { URL.revokeObjectURL(currentCallTtsObjectUrl); } catch (error) { }
    currentCallTtsObjectUrl = null;
  }

  function revokeChatTtsUrl() {
    if (!currentChatTtsObjectUrl) return;
    try { URL.revokeObjectURL(currentChatTtsObjectUrl); } catch (error) { }
    currentChatTtsObjectUrl = null;
  }

  function trimTtsCache() {
    if (!state.ttsCache || typeof state.ttsCache.size !== 'number') return;
    while (state.ttsCache.size > TTS_CACHE_MAX) {
      const oldestKey = state.ttsCache.keys().next().value;
      state.ttsCache.delete(oldestKey);
    }
  }

  function stopTtsQueue() {
    callTtsGeneration++;
    if (callTtsAbortController) {
      callTtsAbortController.abort();
      callTtsAbortController = null;
    }
    ttsQueue.length = 0;
    isTtsPlaying = false;
    const callPlayer = document.getElementById('call-tts-audio-player');
    if (callPlayer) {
      callPlayer.onended = null;
      callPlayer.onerror = null;
      callPlayer.pause();
      callPlayer.removeAttribute('src');
      try { callPlayer.load(); } catch (error) { }
    }
    revokeCallTtsUrl();
  }

  // 单条语音消息播放状态（用于同一条点两次=暂停/取消，退出聊天=停播）
  let currentTtsMessageKey = '';
  let currentTtsLoading = false;
  let ttsAbortController = null;
  let pendingChatTtsAudio = null;
  const activeAiVoiceDownloads = new Set();

  /** 只停聊天语音条播放，不清通话 TTS 队列（打着电话切到别人聊天时用） */
  function stopChatMessageTtsOnly() {
    chatTtsGeneration++;
    if (ttsAbortController) {
      ttsAbortController.abort();
      ttsAbortController = null;
    }
    currentTtsMessageKey = '';
    currentTtsLoading = false;
    if (activeTtsCacheReader) {
      try { activeTtsCacheReader.abort(); } catch (error) { }
      activeTtsCacheReader = null;
    }
    const ttsPlayer = document.getElementById('tts-audio-player');
    if (ttsPlayer) {
      ttsPlayer.onended = null;
      ttsPlayer.onpause = null;
      ttsPlayer.pause();
      ttsPlayer.removeAttribute('src');
      try { ttsPlayer.load(); } catch (error) { }
      delete ttsPlayer.dataset.currentText;
      delete ttsPlayer.dataset.currentVoiceId;
      delete ttsPlayer.dataset.currentMessageKey;
    }
    revokeChatTtsUrl();
    document.querySelectorAll('.voice-play-btn').forEach(btn => { btn.textContent = '▶'; });
    document.querySelectorAll('.voice-message-body .loading-spinner').forEach(el => { el.style.display = 'none'; });
    document.querySelectorAll('.voice-message-body .voice-play-btn').forEach(btn => { btn.style.display = 'flex'; });
  }

  function stopAllTtsPlayback() {
    stopTtsQueue();
    stopChatMessageTtsOnly();
  }

  async function processNextTts() {
    if (ttsQueue.length === 0) {
      isTtsPlaying = false;
      return;
    }

    isTtsPlaying = true;
    const { text, voiceId } = ttsQueue.shift();
    const generation = callTtsGeneration;
    const controller = new AbortController();
    callTtsAbortController = controller;

    try {
      const { minimaxGroupId, minimaxApiKey } = state.apiConfig;
      if (!minimaxGroupId || !minimaxApiKey || !voiceId) {
        processNextTts();
        return;
      }

      console.log(`[TTS队列] 正在朗读 (剩余${ttsQueue.length}条): ${text}`);

      const savedDomain = state.apiConfig.minimaxDomain || localStorage.getItem('minimax-domain') || 'https://api.minimax.chat';
      const modelId = state.apiConfig.minimaxModel || "speech-01-hd";

      const response = await fetch(`${savedDomain}/v1/t2a_v2?GroupId=${minimaxGroupId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${minimaxApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          text: text,
          stream: false,
          voice_setting: {
            voice_id: voiceId,
            speed: 1.0,
            vol: 1.0,
            pitch: 0
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: "mp3",
            channel: 1
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) throw new Error("API请求失败");

      const data = await response.json();
      if (controller.signal.aborted || generation !== callTtsGeneration) return;
      if (data.base_resp && data.base_resp.status_code !== 0) throw new Error(data.base_resp.status_msg);

      const audioHex = data.data?.audio;
      if (!audioHex) {
        processNextTts();
        return;
      }

      const audioBytes = hexToUint8Array(audioHex);
      const audioBlob = new Blob([audioBytes], { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(audioBlob);
      revokeCallTtsUrl();
      currentCallTtsObjectUrl = audioUrl;

      const callPlayer = document.getElementById('call-tts-audio-player');
      callPlayer.src = audioUrl;
      callPlayer.dataset.currentText = text;

      // 播完这条再播下一条
      callPlayer.onended = () => {
        revokeCallTtsUrl();
        processNextTts();
      };
      callPlayer.onerror = () => {
        revokeCallTtsUrl();
        processNextTts();
      };

      await callPlayer.play();

    } catch (error) {
      if (error.name !== 'AbortError' && generation === callTtsGeneration) {
        revokeCallTtsUrl();
        console.error("TTS生成失败:", error);
        processNextTts(); // 失败也继续下一条
      }
    } finally {
      if (callTtsAbortController === controller) callTtsAbortController = null;
    }
  }

  // --- 视频/语音通话专用 TTS 播放函数（队列版） ---
  function playVideoCallPureTTS(text, voiceId) {
    // 1. 正则去除括号及括号内的内容
    let cleanText = text.replace(/(\[.*?\]|\(.*?\)|（.*?）|【.*?】)/g, '').trim();
    if (!cleanText) return;

    // 1.5. 处理"仅读取对话"功能
    if (state.activeChatId && state.chats[state.activeChatId]) {
      const chat = state.chats[state.activeChatId];
      if (chat.videoOptimization && chat.videoOptimization.ttsDialogueOnly) {
        cleanText = extractDialogueOnly(cleanText);
        console.log('[视频通话TTS] 仅读取对话模式：', cleanText);
      }
    }

    if (!cleanText) return;

    // 2. 检查配置
    const { minimaxGroupId, minimaxApiKey } = state.apiConfig;
    if (!minimaxGroupId || !minimaxApiKey || !voiceId) return;

    // 3. 推入队列，串行处理
    ttsQueue.push({ text: cleanText, voiceId });

    if (!isTtsPlaying) {
      processNextTts();
    }
  }
  // 播放真实录音
  async function playRealAudio(bodyElement) {
    const audioData = bodyElement.dataset.audio;
    const audioMime = bodyElement.dataset.audioMime || 'audio/webm';

    if (!audioData) {
      console.error('没有找到音频数据');
      return;
    }

    try {
      const audioDataDecoded = decodeURIComponent(audioData);

      // 创建音频播放器
      let realAudioPlayer = document.getElementById('real-audio-player');
      if (!realAudioPlayer) {
        realAudioPlayer = document.createElement('audio');
        realAudioPlayer.id = 'real-audio-player';
        realAudioPlayer.style.display = 'none';
        document.body.appendChild(realAudioPlayer);
      }

      // 如果正在播放同一条语音，暂停
      if (!realAudioPlayer.paused && realAudioPlayer.dataset.currentAudio === audioData) {
        realAudioPlayer.pause();
        return;
      }

      // 停止之前的播放
      realAudioPlayer.pause();

      // 设置新的音频源
      realAudioPlayer.src = audioDataDecoded;
      realAudioPlayer.dataset.currentAudio = audioData;
      realAudioPlayer.onended = () => {
        realAudioPlayer.removeAttribute('src');
        delete realAudioPlayer.dataset.currentAudio;
        try { realAudioPlayer.load(); } catch (error) { }
      };
      realAudioPlayer.onerror = realAudioPlayer.onended;

      // 播放音频
      await realAudioPlayer.play();
      console.log('播放真实录音');

    } catch (error) {
      console.error('播放录音失败:', error);
      alert('播放录音失败');
    }
  }

  async function playTtsAudio(bodyElement) {
    const bubble = bodyElement.closest('.message-bubble');
    const messageKey = (state.activeChatId || '') + '_' + (bubble?.dataset?.timestamp || '');

    let text = decodeURIComponent(bodyElement.dataset.text);

    // 1. 获取 Voice ID
    let voiceId = bodyElement.dataset.voiceId;
    // 新增：初始化语言设置，默认为普通话
    let ttsLanguage = 'zh-CN';

    if (state.activeChatId && state.chats[state.activeChatId]) {
      const chat = state.chats[state.activeChatId];
      if (!chat.isGroup && chat.settings.enableTts !== false) {
        // 优先使用标签上的ID，如果没有则用设置里的
        if (!voiceId) voiceId = chat.settings.minimaxVoiceId;
        // 【关键修复】获取用户在设置中选择的语言/方言
        if (chat.settings.ttsLanguage) {
          ttsLanguage = chat.settings.ttsLanguage;
        } else if (window.languagePolicy && chat.settings.enableBilingualMode) {
          const policy = window.languagePolicy.getPolicy(chat);
          const selectedLanguage = policy.ttsReadMode === 'translation'
            ? (policy.translationMode === 'interface'
              ? (localStorage.getItem('ephone-language') === 'en' ? 'en-US' : 'zh-Hans-CN')
              : policy.translationLanguage)
            : policy.outputLanguage;
          const languageMap = {
            'zh-Hans-CN': 'zh-CN', 'zh-Hant-TW': 'zh-CN', 'zh-Hant-HK': 'zh-HK',
            'yue-Hant-HK': 'zh-HK', 'yue-Hans-CN': 'zh-HK', 'en-GB': 'en-US',
            'ko-KR': 'ko-KR', 'ja-JP': 'ja-JP', 'fr-FR': 'fr-FR', 'de-DE': 'de-DE',
            'es-MX': 'es-ES', 'pt-PT': 'pt-BR'
          };
          ttsLanguage = languageMap[selectedLanguage] || selectedLanguage || ttsLanguage;
        }
      }

      // 处理"仅读取对话"功能
      if (chat.videoOptimization && chat.videoOptimization.ttsDialogueOnly) {
        // extractDialogueOnly 会返回引号内容或原文，不会返回空
        text = extractDialogueOnly(text);
        console.log('TTS仅读取对话模式：', text);
      }
    }

    if (!voiceId) {
      alert("错误：无法获取 Voice ID。请检查角色设置。");
      return;
    }

    const button = bodyElement.querySelector('.voice-play-btn');
    const spinner = bodyElement.querySelector('.loading-spinner');
    const ttsPlayer = document.getElementById('tts-audio-player');

    // 同一条消息点第二次：正在播放则暂停，正在请求则取消
    if (messageKey && messageKey === currentTtsMessageKey) {
      if (!ttsPlayer.paused && ttsPlayer.dataset.currentMessageKey === messageKey) {
        ttsPlayer.pause();
        currentTtsMessageKey = '';
        if (button) button.textContent = '▶';
        return;
      }
      if (currentTtsLoading && ttsAbortController) {
        ttsAbortController.abort();
        currentTtsMessageKey = '';
        currentTtsLoading = false;
        spinner.style.display = 'none';
        if (button) button.style.display = 'flex';
        return;
      }
    }

    ttsPlayer.pause();
    if (ttsAbortController) {
      ttsAbortController.abort();
      ttsAbortController = null;
    }
    chatTtsGeneration++;
    const generation = chatTtsGeneration;
    currentTtsLoading = false;
    revokeChatTtsUrl();
    document.querySelectorAll('.voice-play-btn').forEach(btn => btn.textContent = '▶');

    // 2. 检查缓存 (Key加入语言区分，防止切换方言后读到旧缓存)
    const cacheKey = `tts_v2_${voiceId}_${ttsLanguage}_${text}`;
    let cachedAudio = state.ttsCache.get(cacheKey);
    if (cachedAudio) {
      console.log("从缓存播放 TTS...");
      // 命中后移到队尾，按真实使用顺序淘汰临时缓存。
      state.ttsCache.delete(cacheKey);
      state.ttsCache.set(cacheKey, cachedAudio);
      trimTtsCache();
      currentTtsMessageKey = messageKey;
      await playAudioFromData(cachedAudio.url, cachedAudio.type, text, voiceId, bodyElement, messageKey, () => { currentTtsMessageKey = ''; });
      return;
    }

    currentTtsMessageKey = messageKey;
    currentTtsLoading = true;
    const controller = new AbortController();
    ttsAbortController = controller;
    const signal = controller.signal;
    let resolvePendingAudio;
    const pendingAudio = {
      messageKey,
      promise: new Promise(resolve => { resolvePendingAudio = resolve; }),
      resolve: blob => resolvePendingAudio(blob)
    };
    pendingChatTtsAudio = pendingAudio;

    console.log(`请求 Minimax T2A v2... VoiceID: ${voiceId}, Language: ${ttsLanguage}`);
    if (button) button.style.display = 'none';
    spinner.style.display = 'block';

    const {
      minimaxGroupId,
      minimaxApiKey
    } = state.apiConfig;

    const languageMap = {
      'zh-CN': 'Chinese',
      'zh-HK': 'Chinese,Yue',   // 粤语特殊处理
      'en-US': 'English',
      'ja-JP': 'Japanese',
      'ko-KR': 'Korean',
      'de-DE': 'German',
      'fr-FR': 'French',
      'es-ES': 'Spanish',
      'it-IT': 'Italian',
      'ru-RU': 'Russian',
      'pt-BR': 'Portuguese',
      'nl-NL': 'Dutch',
      'pl-PL': 'Polish',
      'sv-SE': 'Swedish',
      'tr-TR': 'Turkish',
      'id-ID': 'Indonesian',
      'ms-MY': 'Malay',
      'vi-VN': 'Vietnamese',
      'th-TH': 'Thai',
      'hi-IN': 'Hindi',
      'ar-SA': 'Arabic'
    };

    // 获取对应的 boost 值，如果没有匹配到就默认 'auto'
    const boostValue = languageMap[ttsLanguage] || 'auto';

    // 2. 发送请求 (注意 language_boost 的位置)
    try {
      const savedDomain = state.apiConfig.minimaxDomain || localStorage.getItem('minimax-domain') || 'https://api.minimax.chat';
      const minimaxBaseUrl = savedDomain;
      const modelId = state.apiConfig.minimaxModel || "speech-01-hd";

      const response = await fetch(`${minimaxBaseUrl}/v1/t2a_v2?GroupId=${minimaxGroupId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${minimaxApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          text: text,
          stream: false,


          language_boost: boostValue,

          voice_setting: {
            voice_id: voiceId,
            speed: 1.0,
            vol: 1.0,
            pitch: 0
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: "mp3",
            channel: 1
          }
        }),
        signal
      });

      if (!response.ok) {
        let errorMsg = `API 失败: ${response.status}`;
        try {
          const errJson = await response.json();
          errorMsg += ` - ${errJson.base_resp?.status_msg || JSON.stringify(errJson)}`;
        } catch (e) { }
        throw new Error(errorMsg);
      }

      const data = await response.json();
      if (signal.aborted || generation !== chatTtsGeneration) return;

      // 4. 检查业务状态码
      if (data.base_resp && data.base_resp.status_code !== 0) {
        throw new Error(`API 错误: ${data.base_resp.status_msg}`);
      }

      // 5. 解析 Hex 音频数据
      const audioHex = data.data?.audio;
      if (!audioHex) throw new Error("API 未返回音频数据");

      const audioBytes = hexToUint8Array(audioHex);
      const audioBlob = new Blob([audioBytes], {
        type: 'audio/mpeg'
      });
      pendingAudio.resolve(audioBlob);
      if (pendingChatTtsAudio === pendingAudio) pendingChatTtsAudio = null;
      const audioUrl = URL.createObjectURL(audioBlob);
      revokeChatTtsUrl();
      currentChatTtsObjectUrl = audioUrl;

      await playAudioFromData(audioUrl, 'audio/mpeg', text, voiceId, bodyElement, messageKey, () => {
        currentTtsMessageKey = '';
        revokeChatTtsUrl();
      });

      // 写入仅用于加速重复播放的临时缓存；旧项按插入顺序淘汰，不影响持久化消息。
      if (activeTtsCacheReader) {
        try { activeTtsCacheReader.abort(); } catch (error) { }
      }
      const reader = new FileReader();
      activeTtsCacheReader = reader;
      reader.onloadend = function () {
        if (activeTtsCacheReader === reader) activeTtsCacheReader = null;
        if (reader.error || generation !== chatTtsGeneration || typeof reader.result !== 'string') return;
        state.ttsCache.set(cacheKey, {
          url: reader.result,
          type: 'audio/mpeg'
        });
        trimTtsCache();
      }
      reader.readAsDataURL(audioBlob);

    } catch (error) {
      if (error.name === 'AbortError') return;
      if (generation !== chatTtsGeneration) return;
      if (generation === chatTtsGeneration) revokeChatTtsUrl();
      console.error("TTS 生成失败:", error);
      await showCustomAlert("语音生成失败", `错误: ${error.message}`);
    } finally {
      pendingAudio.resolve(null);
      if (pendingChatTtsAudio === pendingAudio) pendingChatTtsAudio = null;
      if (generation === chatTtsGeneration) currentTtsLoading = false;
      if (ttsAbortController === controller) ttsAbortController = null;
      spinner.style.display = 'none';
      if (button) button.style.display = 'flex';
    }
  }

  async function downloadAiVoiceMessage(chatId, timestamp) {
    const chat = state.chats[chatId];
    const message = chat?.history.find(item => item.timestamp === timestamp);
    if (state.activeChatId !== chatId || !message || message.role !== 'assistant'
        || message.type !== 'voice_message' || chat.isGroup || chat.settings.enableTts === false) return;

    const downloadKey = `${chatId}_${timestamp}`;
    if (activeAiVoiceDownloads.has(downloadKey)) {
      showToast('这条语音正在下载', 'info');
      return;
    }
    activeAiVoiceDownloads.add(downloadKey);
    let loadingToast = null;

    try {
      const body = document.querySelector(`.message-bubble[data-timestamp="${timestamp}"] .voice-message-body`);
      if (!body) throw new Error('找不到这条语音，请返回聊天后重试');

      let text = decodeURIComponent(body.dataset.text || '');
      const voiceId = body.dataset.voiceId || chat.settings.minimaxVoiceId;
      if (!voiceId) throw new Error('未设置语音 ID，请先检查角色设置');

      let ttsLanguage = chat.settings.ttsLanguage || 'zh-CN';
      if (!chat.settings.ttsLanguage && window.languagePolicy && chat.settings.enableBilingualMode) {
        const policy = window.languagePolicy.getPolicy(chat);
        const selectedLanguage = policy.ttsReadMode === 'translation'
          ? (policy.translationMode === 'interface'
            ? (localStorage.getItem('ephone-language') === 'en' ? 'en-US' : 'zh-Hans-CN')
            : policy.translationLanguage)
          : policy.outputLanguage;
        const languageMap = {
          'zh-Hans-CN': 'zh-CN', 'zh-Hant-TW': 'zh-CN', 'zh-Hant-HK': 'zh-HK',
          'yue-Hant-HK': 'zh-HK', 'yue-Hans-CN': 'zh-HK', 'en-GB': 'en-US',
          'ko-KR': 'ko-KR', 'ja-JP': 'ja-JP', 'fr-FR': 'fr-FR', 'de-DE': 'de-DE',
          'es-MX': 'es-ES', 'pt-PT': 'pt-BR'
        };
        ttsLanguage = languageMap[selectedLanguage] || selectedLanguage || ttsLanguage;
      }
      if (chat.videoOptimization?.ttsDialogueOnly) text = extractDialogueOnly(text);

      const messageKey = `${chatId}_${timestamp}`;
      const cacheKey = `tts_v2_${voiceId}_${ttsLanguage}_${text}`;
      const player = document.getElementById('tts-audio-player');
      let audioBlob = null;

      if (currentChatTtsObjectUrl && player?.dataset.currentMessageKey === messageKey) {
        try { audioBlob = await fetch(currentChatTtsObjectUrl).then(response => response.blob()); }
        catch (error) { /* 播放结束后 Blob URL 可能已被释放，继续查缓存。 */ }
      }
      if (!audioBlob && state.ttsCache.has(cacheKey)) {
        audioBlob = await fetch(state.ttsCache.get(cacheKey).url).then(response => response.blob());
      }
      if (!audioBlob && pendingChatTtsAudio?.messageKey === messageKey) {
        loadingToast = showToast('正在等待语音生成', 'loading');
        audioBlob = await pendingChatTtsAudio.promise;
      }

      if (!audioBlob) {
        loadingToast?.remove();
        loadingToast = showToast('正在生成 MP3，可能产生 API 用量', 'loading');
        const { minimaxGroupId, minimaxApiKey } = state.apiConfig;
        if (!minimaxGroupId || !minimaxApiKey) throw new Error('请先配置 Minimax 语音 API');
        const languageMap = {
          'zh-CN': 'Chinese', 'zh-HK': 'Chinese,Yue', 'en-US': 'English',
          'ja-JP': 'Japanese', 'ko-KR': 'Korean', 'de-DE': 'German',
          'fr-FR': 'French', 'es-ES': 'Spanish', 'it-IT': 'Italian',
          'ru-RU': 'Russian', 'pt-BR': 'Portuguese', 'nl-NL': 'Dutch',
          'pl-PL': 'Polish', 'sv-SE': 'Swedish', 'tr-TR': 'Turkish',
          'id-ID': 'Indonesian', 'ms-MY': 'Malay', 'vi-VN': 'Vietnamese',
          'th-TH': 'Thai', 'hi-IN': 'Hindi', 'ar-SA': 'Arabic'
        };
        const savedDomain = state.apiConfig.minimaxDomain || localStorage.getItem('minimax-domain') || 'https://api.minimax.chat';
        const response = await fetch(`${savedDomain}/v1/t2a_v2?GroupId=${minimaxGroupId}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${minimaxApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: state.apiConfig.minimaxModel || 'speech-01-hd',
            text,
            stream: false,
            language_boost: languageMap[ttsLanguage] || 'auto',
            voice_setting: { voice_id: voiceId, speed: 1.0, vol: 1.0, pitch: 0 },
            audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 }
          })
        });
        if (!response.ok) {
          let errorMessage = `API 失败: ${response.status}`;
          try {
            const errorData = await response.json();
            errorMessage += ` - ${errorData.base_resp?.status_msg || JSON.stringify(errorData)}`;
          } catch (error) { }
          throw new Error(errorMessage);
        }
        const data = await response.json();
        if (data.base_resp && data.base_resp.status_code !== 0) {
          throw new Error(`API 错误: ${data.base_resp.status_msg}`);
        }
        if (!data.data?.audio) throw new Error('API 未返回音频数据');
        audioBlob = new Blob([hexToUint8Array(data.data.audio)], { type: 'audio/mpeg' });

        const reader = new FileReader();
        reader.onloadend = () => {
          if (!reader.error && typeof reader.result === 'string' && !state.ttsCache.has(cacheKey)) {
            state.ttsCache.set(cacheKey, { url: reader.result, type: 'audio/mpeg' });
            trimTtsCache();
          }
        };
        reader.readAsDataURL(audioBlob);
      }

      if (!audioBlob.size) throw new Error('音频文件为空，请重试');
      const safeChatName = String(chat.name || 'AI').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 32) || 'AI';
      const audioUrl = URL.createObjectURL(audioBlob);
      const link = document.createElement('a');
      link.href = audioUrl;
      link.download = `${safeChatName}_语音_${timestamp}.mp3`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(audioUrl), 60000);
      showToast('已开始下载 MP3', 'success');
    } catch (error) {
      console.error('下载 AI 语音失败:', error);
      showCustomAlert('下载 MP3 失败', error.message || '请稍后重试');
    } finally {
      loadingToast?.remove();
      activeAiVoiceDownloads.delete(downloadKey);
    }
  }


  function playAudioFromData(audioSrc, audioType, text, voiceId, bodyElement, messageKey, onEndedCallback) {
    return new Promise((resolve, reject) => {
      const ttsPlayer = document.getElementById('tts-audio-player');

      ttsPlayer.src = audioSrc;
      ttsPlayer.type = audioType;
      ttsPlayer.dataset.currentText = text;
      ttsPlayer.dataset.currentVoiceId = voiceId;
      if (messageKey) ttsPlayer.dataset.currentMessageKey = messageKey;

      const playPromise = ttsPlayer.play();

      if (playPromise !== undefined) {
        playPromise.then(() => {
          const button = bodyElement.querySelector('.voice-play-btn');
          if (button) button.textContent = '❚❚';


          resolve();
        }).catch(error => {
          console.error("音频播放失败:", error);
          reject(error);
        });
      }

      ttsPlayer.onended = () => {
        const button = bodyElement.querySelector('.voice-play-btn');
        if (button) button.textContent = '▶';
        if (typeof onEndedCallback === 'function') onEndedCallback();
      };
      ttsPlayer.onpause = () => {
        const button = bodyElement.querySelector('.voice-play-btn');
        if (button) button.textContent = '▶';
      };
    });
  }




  function toggleVoiceTranscript(bodyElement) {
    const bubble = bodyElement.closest('.message-bubble');
    if (!bubble) return;

    const transcriptEl = bubble.querySelector('.voice-transcript');
    const text = decodeURIComponent(bodyElement.dataset.text);

    if (transcriptEl.style.display === 'block') {

      transcriptEl.style.display = 'none';
    } else {
      // 【双语模式】检查是否有原始双语内容
      const originalContent = bodyElement.dataset.originalContent;
      
      if (originalContent) {
        // 有双语内容：显示角色原文与目标译文。
        const decodedOriginal = decodeURIComponent(originalContent);
        const languageParts = window.languagePolicy
          ? window.languagePolicy.splitContent(decodedOriginal)
          : null;
        const foreignText = languageParts
          ? languageParts.sourceText
          : decodedOriginal.replace(/[〖【][^〗】]*[〗】]/g, '').trim();
        const translationMatches = languageParts ? null : decodedOriginal.match(/[〖【]\s*([^〗】]+?)\s*[〗】]/g);
        const translation = languageParts
          ? languageParts.translationText
          : (translationMatches || []).map(m => m.replace(/[〖【〗】]/g, '').trim()).filter(Boolean).join(' ');
        
        // 构建显示内容：外语 + 换行 + 中文翻译
        if (translation) {
          transcriptEl.innerHTML = `
            <div style="margin-bottom: 6px;">${foreignText}</div>
            <div style="color: var(--text-secondary); font-size: 0.92em; opacity: 0.85; border-top: 1px solid rgba(0,0,0,0.06); padding-top: 6px; margin-top: 6px;">${translation}</div>
          `;
        } else {
          // 没有找到翻译，只显示外语
          transcriptEl.textContent = foreignText;
        }
      } else {
        // 没有双语内容，正常显示
        transcriptEl.textContent = text;
      }
      
      transcriptEl.style.display = 'block';
    }
  }

  // 双语翻译切换函数
  function toggleBilingualTranslation(bubble, chat) {
    const originalContent = bubble.dataset.originalContent;
    if (!originalContent) return; // 没有双语内容
    
    const isShowingTranslation = bubble.dataset.showingTranslation === 'true';
    const contentEl = bubble.querySelector('.content');
    const displayMode = chat.settings.bilingualDisplayMode || 'outside';
    
    // 检查是否是语音消息
    const isVoiceMessage = bubble.classList.contains('is-voice-message');
    
    if (isShowingTranslation) {
      // 隐藏翻译
      if (isVoiceMessage) {
        // 语音消息：在 voice-transcript 区域隐藏翻译
        const transcriptEl = bubble.querySelector('.voice-transcript');
        if (transcriptEl) {
          transcriptEl.textContent = '';
          transcriptEl.style.display = 'none';
        }
      } else {
        // 文本消息：原有逻辑
        if (displayMode === 'inside') {
          // 内部模式：恢复只显示外语
          const englishOnly = originalContent.replace(/[〖【][^〗】]*[〗】]/g, '');
          contentEl.innerHTML = parseMarkdown(englishOnly).replace(/\n/g, '<br>');
        } else {
          // 外部模式：移除翻译元素（从wrapper中移除）
          const contentRow = bubble.closest('.message-content-row');
          const wrapper = contentRow ? contentRow.parentElement : null;
          if (wrapper) {
            const transEl = wrapper.querySelector('.translation-bubble');
            if (transEl) transEl.remove();
          }
        }
      }
      bubble.dataset.showingTranslation = 'false';
    } else {
      // 显示翻译
      const translation = extractBilingualTranslation(originalContent, bubble);
      if (!translation) {
        console.warn('[双语模式] 未找到翻译内容，AI可能未按格式输出');
        return;
      }
      
      if (isVoiceMessage) {
        // 语音消息：在 voice-transcript 区域显示翻译
        const transcriptEl = bubble.querySelector('.voice-transcript');
        if (transcriptEl) {
          transcriptEl.textContent = `翻译：${translation}`;
          transcriptEl.style.display = 'block';
          transcriptEl.style.marginTop = '8px';
          transcriptEl.style.fontSize = '13px';
          transcriptEl.style.color = 'var(--text-secondary)';
          transcriptEl.style.opacity = '0.85';
        }
      } else {
        // 文本消息：原有逻辑
        if (displayMode === 'inside') {
          // 内部模式：外语 + 翻译（用换行分隔）
          const englishOnly = originalContent.replace(/[〖【][^〗】]*[〗】]/g, '');
          contentEl.innerHTML = parseMarkdown(englishOnly).replace(/\n/g, '<br>') + 
            '<br><span style="color: var(--text-secondary); font-size: 0.95em;">' + 
            translation + '</span>';
        } else {
          // 外部模式：在wrapper中添加翻译气泡（作为contentRow的兄弟元素）
          const contentRow = bubble.closest('.message-content-row');
          const wrapper = contentRow ? contentRow.parentElement : null;
          if (wrapper) {
            const transEl = document.createElement('div');
            transEl.className = 'translation-bubble';
            transEl.textContent = translation;
            transEl.dataset.linkedBubble = bubble.dataset.timestamp || Date.now();
            
            // 添加到wrapper的末尾（contentRow下方）
            wrapper.appendChild(transEl);
          }
        }
      }
      bubble.dataset.showingTranslation = 'true';
    }
  }

  // 提取双语翻译内容
  function extractBilingualTranslation(content, bubble) {
    // 检查缓存
    if (bubble.dataset.cachedTranslation) {
      return bubble.dataset.cachedTranslation;
    }
    
    if (window.languagePolicy) {
      const translation = window.languagePolicy.splitContent(content).translationText;
      if (!translation) return null;
      bubble.dataset.cachedTranslation = translation;
      return translation;
    }
    
    // 【预处理】清理可能的隐藏字符和统一符号
    let cleanedContent = content
      // 清理零宽字符
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      // 统一全角括号为〖〗
      .replace(/【/g, '〖')
      .replace(/】/g, '〗')
      // 清理可能的多余空格
      .trim();
    
    console.log('[双语调试] 清理后内容:', cleanedContent);
    
    // 【增强正则】支持多种格式
    // 1. 标准格式：〖中文〗
    // 2. 带空格：〖 中文 〗
    // 3. 换行格式：\n〖中文〗
    const matches = cleanedContent.match(/[〖【]\s*([^〗】]+?)\s*[〗】]/g);
    
    console.log('[双语调试] 匹配结果:', matches);
    
    if (!matches || matches.length === 0) {
      console.warn('[双语调试] 未匹配到翻译内容！');
      return null;
    }
    
    // 提取括号内的内容
    const translation = matches
      .map(m => m.replace(/[〖【〗】]/g, '').trim())
      .filter(t => t.length > 0)
      .join(' ');
    
    console.log('[双语调试] 提取的翻译:', translation);
    
    // 缓存结果
    bubble.dataset.cachedTranslation = translation;
    
    return translation;
  }

  // ========== 全局暴露 ==========
  window.playTtsAudio = playTtsAudio;
  window.downloadAiVoiceMessage = downloadAiVoiceMessage;
  window.playRealAudio = playRealAudio;
  window.playSilentAudio = playSilentAudio;
  window.stopSilentAudio = stopSilentAudio;
  window.stopTtsQueue = stopTtsQueue;
  window.stopChatMessageTtsOnly = stopChatMessageTtsOnly;
  window.stopAllTtsPlayback = stopAllTtsPlayback;
  window.playVideoCallPureTTS = playVideoCallPureTTS;
  window.toggleVoiceTranscript = toggleVoiceTranscript;
  window.toggleBilingualTranslation = toggleBilingualTranslation;

  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopAllTtsPlayback();
    stopSilentAudio();
    const realAudioPlayer = document.getElementById('real-audio-player');
    if (realAudioPlayer) {
      realAudioPlayer.pause();
      realAudioPlayer.removeAttribute('src');
      delete realAudioPlayer.dataset.currentAudio;
      try { realAudioPlayer.load(); } catch (error) { }
    }
  });
