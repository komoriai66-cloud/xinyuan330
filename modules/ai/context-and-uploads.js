// ============================================================
// ai-response.js
// AI 响应模块：toGeminiRequestData、uploadImageToImgBB、uploadFileToCatbox、
// silentlyUpdateDbUrl、parseAiResponse、triggerSpectatorGroupAiAction、triggerAiResponse
// 从 script.js 第 1346~1421 + 2553~2852 + 8979~9060 + 13711~19173 + 14027~19165 行拆分
// ============================================================

  // === 新增：动态年龄和生日计算上下文生成函数 ===
  function getDynamicAgeContext(chat) {
    if (!chat || !chat.settings || !chat.settings.enableDynamicAge || !chat.settings.aiBirthday) return '';
    
    const bd = chat.settings.aiBirthday;
    if (!bd.year) return ''; // 必须至少要有年份

    // 判断是否开启了自定义时间
    const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime(chat) : null;
    const now = (customTimeInfo && customTimeInfo.enabled) ? customTimeInfo.date : new Date();

    let age = now.getFullYear() - bd.year;
    
    // 构建生日字符串
    let birthdayStr = `${bd.year}年`;
    if (bd.month) {
      birthdayStr += `${bd.month}月`;
      if (bd.day) {
        birthdayStr += `${bd.day}日`;
      }
    }

    // 精确计算年龄
    if (bd.month && bd.day) {
      const m = now.getMonth() + 1;
      const d = now.getDate();
      if (m < bd.month || (m === bd.month && d < bd.day)) {
        age--;
      }
    }

    return `- **你的生日**: ${birthdayStr}\n- **你的当前年龄**: ${age}岁\n`;
  }

  // WMO天气代码转中文描述
  function getWeatherDescription(code) {
    const codes = {
      0: "晴朗 (Clear sky)",
      1: "大部晴朗 (Mainly clear)", 2: "多云 (Partly cloudy)", 3: "阴天 (Overcast)",
      45: "有雾 (Fog)", 48: "结霜雾 (Depositing rime fog)",
      51: "轻微毛毛雨 (Drizzle: Light)", 53: "中度毛毛雨 (Drizzle: Moderate)", 55: "大毛毛雨 (Drizzle: Dense)",
      61: "小雨 (Rain: Slight)", 63: "中雨 (Rain: Moderate)", 65: "大雨 (Rain: Heavy)",
      71: "小雪 (Snow fall: Slight)", 73: "中雪 (Snow fall: Moderate)", 75: "大雪 (Snow fall: Heavy)",
      80: "阵雨 (Rain showers)", 81: "中度阵雨", 82: "暴雨",
      95: "雷雨 (Thunderstorm)", 96: "雷雨伴有冰雹", 99: "重度雷雨伴有冰雹"
    };
    return codes[code] || "未知天气";
  }

  // 根据经纬度获取实时天气
  async function fetchWeather(lat, lon) {
    if (!lat || !lon) return null;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,is_day,wind_speed_10m&timezone=auto`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.current) {
        const c = data.current;
        const desc = getWeatherDescription(c.weather_code);
        const dayState = c.is_day ? "白天" : "夜晚";
        return `气温 ${c.temperature_2m}°C, 湿度 ${c.relative_humidity_2m}%, ${desc}, ${dayState}, 风速 ${c.wind_speed_10m}km/h`;
      }
      return null;
    } catch (e) {
      console.error("获取天气失败:", e);
      return null;
    }
  }

  // 获取天气上下文信息，用于AI prompt
  async function getWeatherContextForPrompt(chat) {
    const wSettings = chat.settings.weather || {};
    if (!wSettings.enabled) return "";

    let context = "\n# 【实时环境与天气同步】\n";
    let hasData = false;

    // 获取用户天气
    if (wSettings.userLat && wSettings.userLon) {
      const userWeather = await fetchWeather(wSettings.userLat, wSettings.userLon);
      if (userWeather) {
        const locationName = wSettings.userVirtualCity || "所在地";
        context += `- 用户(${chat.settings.myNickname || '我'})当前在【${locationName}】: ${userWeather}。\n`;
        hasData = true;
      }
    }

    // 获取角色天气
    if (wSettings.charLat && wSettings.charLon) {
      const charWeather = await fetchWeather(wSettings.charLat, wSettings.charLon);
      if (charWeather) {
        const locationName = wSettings.charVirtualCity || "所在地";
        context += `- 你(${chat.name})当前在【${locationName}】: ${charWeather}。\n`;
        hasData = true;
      }
    }

    if (!hasData) return "";

    context += "请根据上述天气和时间状态（如是否下雨、是白天还是夜晚）来调整你的描写氛围、角色的行动（如撑伞、避暑、添衣）以及对话内容。";
    return context;
  }

  function toGeminiRequestData(model, apiKey, systemInstruction, messagesForDecision, options) {
    options = options || {};
    const apiTemperature = state.globalSettings.apiTemperature || 0.8;
    const apiTopP = state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0;
    const apiPresencePenalty = state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0;
    const apiFrequencyPenalty = state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0;
    const roleType = {
      user: 'user',
      assistant: 'model',
      system: 'user'
    };


    const contents = [{
      role: 'user',
      parts: [{
        text: systemInstruction
      }]
    },
    {
      role: 'model',
      parts: [{
        text: '好的，我明白了。我会严格遵守以上所有规则和设定。'
      }]
    },

    ...messagesForDecision.map((item) => {
      const parts = [];

      if (item.role === 'tool') {
        let response;
        try { response = JSON.parse(item.content || '{}'); }
        catch (error) { response = { result: String(item.content || '') }; }
        return {
          role: 'user',
          parts: [{
            functionResponse: {
              name: item.name,
              response
            }
          }]
        };
      }

      if (item.role === 'assistant' && Array.isArray(item.tool_calls)) {
        if (item.content) parts.push({ text: String(item.content) });
        item.tool_calls.forEach(call => {
          let args = {};
          try { args = JSON.parse(call.function && call.function.arguments || '{}'); }
          catch (error) { /* Invalid arguments are handled by the orchestrator. */ }
          parts.push({
            functionCall: {
              name: call.function && call.function.name,
              args
            }
          });
        });
        return { role: 'model', parts };
      }

      if (Array.isArray(item.content)) {
        item.content.forEach(part => {
          if (part.type === 'text') {
            parts.push({
              text: part.text
            });
          } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {

            const currentImageData = part.image_url.url;
            const base64Data = currentImageData.split(',')[1];
            const mimeTypeMatch = currentImageData.match(/^data:(.*);base64/);
            if (mimeTypeMatch && base64Data) {
              parts.push({
                inline_data: {
                  mime_type: mimeTypeMatch[1],
                  data: base64Data
                }
              });
            }
          }
        });
      } else {

        parts.push({ text: String(item.content == null ? '' : item.content) });
      }
      return {
        role: roleType[item.role],
        parts: parts
      };
    })
    ];


    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getRandomValue(apiKey)}`,
      data: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: contents,
          ...(Array.isArray(options.tools) && options.tools.length ? {
            tools: [{
              functionDeclarations: options.tools.map(tool => ({
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters
              }))
            }],
            toolConfig: {
              functionCallingConfig: {
                mode: options.forceFinal ? 'NONE' : 'AUTO'
              }
            }
          } : {}),
          generationConfig: {
            temperature: apiTemperature,
            topP: apiTopP,
            presencePenalty: apiPresencePenalty,
            frequencyPenalty: apiFrequencyPenalty,
          },
        })
      }
    };
  }



  async function uploadImageToImgBB(base64String) {
    // 1. 检查功能是否开启
    if (!state.apiConfig.imgbbEnable || !state.apiConfig.imgbbApiKey) {
      // console.log("ImgBB 未开启，返回原始 Base64。");
      return base64String; // 功能未开启，直接返回
    }

    // 2. 检查是否已经是 URL
    if (!base64String || !base64String.startsWith('data:image')) {
      // console.log("输入已是 URL 或为空，无需上传。");
      return base64String; // 已经是 URL 或为空，无需上传
    }

    // 3. 提取 Base64 数据
    // 格式为 data:image/png;base64,iVBORw0KGgo...
    const base64Data = base64String.split(',')[1];
    if (!base64Data) {
      console.warn("无法从字符串中提取 Base64 数据:", base64String.substring(0, 50) + "...");
      return base64String; // 格式错误，返回原文
    }

    console.log(`[ImgBB] 开始上传图片... (大小: ${(base64String.length / 1024).toFixed(1)} KB)`);

    try {
      const formData = new FormData();
      formData.append('image', base64Data);

      const response = await fetch(`https://api.imgbb.com/1/upload?key=${state.apiConfig.imgbbApiKey}`, {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (result.success && result.data && result.data.url) {
        console.log("[ImgBB] 上传成功! URL:", result.data.url);
        return result.data.url; // 成功！返回 URL
      } else {
        // ImgBB API 返回了错误
        throw new Error(result.error?.message || 'ImgBB API 返回了未知错误。');
      }
    } catch (error) {
      console.error("[ImgBB] 上传失败:", error);
      // 抛出错误，让调用此函数的上层逻辑知道上传失败了
      throw new Error(`ImgBB 上传失败: ${error.message}`);
    }
  }
  async function uploadFileToCatbox(fileObject) {
    // 1. 检查功能是否开启
    if (!state.apiConfig.catboxEnable || !state.apiConfig.catboxUserHash) {
      console.log("[Catbox] 功能未开启或未配置 User Hash，跳过上传。");
      return null; // 功能未开启，返回 null 以便回退
    }

    const userHash = state.apiConfig.catboxUserHash;
    console.log(`[Catbox] 开始上传文件: ${fileObject.name || 'blob.mp3'}... (大小: ${(fileObject.size / 1024 / 1024).toFixed(2)} MB)`);

    try {
      const formData = new FormData();
      formData.append('reqtype', 'fileupload');
      formData.append('userhash', userHash);
      formData.append('fileToUpload', fileObject, fileObject.name || 'track.mp3'); // 提供文件名

      // ▼▼▼ 【核心修复】 ▼▼▼
      // 1. 定义 Catbox API URL
      let apiUrl = 'https://catbox.moe/user/api.php';

      // 2. 获取 CORS 代理设置 (复用 NovelAI 的设置)
      const proxySettings = getNovelAISettings(); // This function is around line 4504
      let corsProxy = proxySettings.cors_proxy;
      if (corsProxy === 'custom') {
        corsProxy = proxySettings.custom_proxy_url || '';
      }

      // 3. 如果代理存在, 则使用代理
      if (corsProxy && corsProxy !== '') {
        // 【重要】Catbox API URL 不需要编码，而 NovelAI 需要，这里我们直接拼接
        apiUrl = corsProxy + apiUrl;
        console.log(`[Catbox] 检测到CORS代理，使用代理上传: ${apiUrl}`);
      } else {
        console.log("[Catbox] 未配置CORS代理，尝试直连... (这很可能会失败)");
      }
      // ▲▲▲ 【修复结束】 ▲▲▲

      const response = await fetch(apiUrl, { // <-- 替换为 apiUrl
        method: 'POST',
        body: formData
      });

      const responseText = await response.text();

      if (response.ok && responseText.startsWith('http')) {
        console.log("[Catbox] 上传成功! URL:", responseText);
        return responseText; // 成功！返回 URL
      } else {
        // Catbox API 返回了错误文本
        throw new Error(responseText || 'Catbox API 返回了未知错误。');
      }
    } catch (error) {
      console.error("[Catbox] 上传失败:", error);
      // 抛出错误，让调用此函数的上层逻辑知道上传失败了
      // 【重要】我们在这里只抛出原始错误，以便上层函数可以捕获并显示它
      throw error;
    }
  }
  async function silentlyUpdateDbUrl(table, recordId, pathString, base64ToFind, nameToMatch = null) {
    if (!state.apiConfig.imgbbEnable || !state.apiConfig.imgbbApiKey) {
      console.log(`[ImgBB Silent Update] ImgBB is disabled, skipping silent upload for ${table.name}.${recordId}.${pathString}.`);
      return; // ImgBB not enabled, do nothing.
    }

    let imageUrl;
    try {
      imageUrl = await uploadImageToImgBB(base64ToFind);
      if (imageUrl === base64ToFind) {
        console.log("[ImgBB Silent Update] Upload returned Base64 (or failed), no update needed.");
        return; // Upload failed or was skipped
      }
    } catch (uploadError) {
      console.error(`[ImgBB Silent Update] Background upload failed for ${table.name}.${recordId}.${pathString}:`, uploadError.message);
      return; // Upload failed
    }

    console.log(`[ImgBB Silent Update] Success. New URL: ${imageUrl}. Finding record to update...`);

    try {
      const record = await table.get(recordId);
      if (!record) {
        console.warn(`[ImgBB Silent Update] Could not find record ${recordId} in table ${table.name}.`);
        return;
      }

      let updated = false;

      // 辅助函数：通过路径字符串深入对象，返回父级和最后的键
      function getNestedParent(obj, path) {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
          if (current[keys[i]] === undefined || current[keys[i]] === null) {
            console.warn(`[ImgBB Silent Update] Invalid path: ${path} in record at key ${keys[i]}.`);
            return null; // Path does not exist
          }
          current = current[keys[i]];
        }
        return { parent: current, finalKey: keys[keys.length - 1] };
      }

      if (nameToMatch) {
        // --- 逻辑 A: 搜索数组 ---
        const result = getNestedParent(record, pathString);
        if (result && Array.isArray(result.parent[result.finalKey])) {
          const arrayToSearch = result.parent[result.finalKey];
          const itemToUpdate = arrayToSearch.find(item => item.url === base64ToFind && item.name === nameToMatch);

          if (itemToUpdate) {
            itemToUpdate.url = imageUrl;
            updated = true;
            console.log(`[ImgBB Silent Update] Found and updated item "${nameToMatch}" in array ${pathString}.`);
          } else {
            console.warn(`[ImgBB Silent Update] Could not find item "${nameToMatch}" with matching Base64 in array ${pathString} to update.`);
          }
        } else {
          console.warn(`[ImgBB Silent Update] Path ${pathString} did not resolve to a valid array.`);
        }
      } else {
        // --- 逻辑 B: 更新简单属性 (如 'url' 或 'widgetData.polaroid-img-1') ---
        const result = getNestedParent(record, pathString);
        if (result && result.parent[result.finalKey] === base64ToFind) {
          result.parent[result.finalKey] = imageUrl;
          updated = true;
          console.log(`[ImgBB Silent Update] Found and updated simple path ${pathString}.`);
        } else if (result) {
          console.warn(`[ImgBB Silent Update] Value changed since upload for ${pathString}. Expected Base64, found: ${String(result.parent[result.finalKey]).substring(0, 30)}...`);
        } else {
          console.warn(`[ImgBB Silent Update] Path ${pathString} did not resolve to a matching string.`);
        }
      }


      if (updated) {
        await table.put(record);
        console.log(`[ImgBB Silent Update] Successfully updated DB for ${table.name}.${recordId}.${pathString}.`);

        // 更新内存 (state.globalSettings)
        if (table.name === 'globalSettings' && recordId === 'main') {
          // (重新获取更新后的内存状态)
          const stateResult = getNestedParent(state, `globalSettings.${pathString}`);
          if (nameToMatch && stateResult && Array.isArray(stateResult.parent[stateResult.finalKey])) {
            const stateArray = stateResult.parent[stateResult.finalKey];
            const stateItem = stateArray.find(item => item.url === base64ToFind && item.name === nameToMatch);
            if (stateItem) stateItem.url = imageUrl;
          } else if (!nameToMatch && stateResult && stateResult.parent[stateResult.finalKey] === base64ToFind) {
            stateResult.parent[stateResult.finalKey] = imageUrl;
          }
          console.log(`[ImgBB Silent Update] In-memory state.globalSettings updated.`);
        }
      }
    } catch (dbError) {
      console.error(`[ImgBB Silent Update] Failed to save updated URL to DB for ${table.name}.${recordId}.${pathString}:`, dbError);
    }
  }


  // ========== 提示词变量替换与旧版兼容 ==========
  function replaceTemplateVars(template, contextMap) {
    if (!template) return '';
    let p = template;
    
    // 1. 粗犷替换旧版的复杂 ${...} 表达式，映射为新版 {{...}}
    p = p.replace(/\$\{chat\.originalName\}/g, '{{chat.originalName}}');
    p = p.replace(/\$\{chat\.name\}/g, '{{chat.name}}');
    p = p.replace(/\$\{chat\.settings\.aiPersona\}/g, '{{aiPersona}}');
    p = p.replace(/\$\{latestThoughtContext\}/g, '{{latestThoughtContext}}');
    p = p.replace(/\$\{worldBookContent\s*\|\|[^}]*\}/g, '{{worldBookContent}}');
    p = p.replace(/\$\{worldBookContent\}/g, '{{worldBookContent}}');
    p = p.replace(/\$\{getMemoryContextForPrompt\(chat\)\}/g, '{{memoryContextForPrompt}}');
    p = p.replace(/\$\{multiLayeredSummaryContext\}/g, '{{multiLayeredSummaryContext}}');
    p = p.replace(/\$\{multiLayeredSummaryContext_group\}/g, '{{multiLayeredSummaryContext_group}}');
    p = p.replace(/\$\{todoListContext\}/g, '{{todoListContext}}');
    p = p.replace(/\$\{periodSummaryContext\}/g, '{{periodSummaryContext}}');
    p = p.replace(/\$\{myNickname\}/g, '{{myNickname}}');
    p = p.replace(/\$\{myOriginalName\}/g, '{{myOriginalName}}');
    p = p.replace(/\$\{chat\.settings\.myPersona[^\}]*\}/g, '{{myPersona}}');
    
    // 特别处理连着两个 ${} 的 status，如 ${chat.settings.userStatus ? ...} ${chat...}
    p = p.replace(/\$\{chat\.settings\.userStatus[^\n]*?\}\s*(?:\$\{chat\.settings\.userStatus[^\}]*\})?/g, '{{userStatus}}');
    
    p = p.replace(/\$\{userProfileContext\}/g, '{{userProfileContext}}');
    p = p.replace(/\$\{nameHistoryContext\}/g, '{{nameHistoryContext}}');
    
    p = p.replace(/\$\{chat\.settings\.enableTimePerception[^\n]*\}/g, '{{timePerceptionContext}}');
    p = p.replace(/\$\{weatherContext\}/g, '{{weatherContext}}');
    p = p.replace(/\$\{timeContext\}/g, '{{timeContext}}');
    p = p.replace(/\$\{timeContextText\}/g, '{{groupTimeContextText}}');
    p = p.replace(/\$\{musicContext\s*\?[^\n]*\}/g, '{{musicContextStr}}');
    p = p.replace(/\$\{readingContext\s*\?[^\n]*\}/g, '{{readingContextStr}}');
    p = p.replace(/\$\{contactsList\}/g, '{{contactsList}}');
    p = p.replace(/\$\{postsContext\}/g, '{{postsContext}}');
    p = p.replace(/\$\{groupContext\}/g, '{{groupContext}}');
    p = p.replace(/\$\{gomokuContext\}/g, '{{gomokuContext}}');
    p = p.replace(/\$\{sharedContext\}/g, '{{sharedContext}}');
    p = p.replace(/\$\{callTranscriptContext\}/g, '{{callTranscriptContext}}');
    p = p.replace(/\$\{synthMusicInstruction\}/g, '{{synthMusicInstruction}}');
    p = p.replace(/\$\{narratorInstruction\}/g, '{{narratorInstruction}}');
    p = p.replace(/\$\{kinshipContext\}/g, '{{kinshipContext}}');
    p = p.replace(/\$\{coupleSpaceContext\}/g, '{{coupleSpaceContext}}');
    p = p.replace(/\$\{thoughtsPrompt\}/g, '{{thoughtsPrompt}}');
    p = p.replace(/\$\{stickerContext\}/g, '{{stickerContext}}');
    p = p.replace(/\$\{chat\.settings\.aiAvatarLibrary[^\n]*\}/g, '{{aiAvatarLibrary}}');
    p = p.replace(/\$\{chat\.settings\.myAvatarLibrary[^\n]*\}/g, '{{myAvatarLibrary}}');

    p = p.replace(/\$\{chat\.longTermMemory[\s\S]*?暂无\)'\}/g, '{{memoryContextForPrompt}}');
    p = p.replace(/\$\{chat\.settings\.enableDynamicCurrency[\s\S]*?CNY[\s\S]*?''\}/g, '');
    p = p.replace(/\$\{chat\.settings\.enableDynamicCurrency[\s\S]*?货币与汇率信息[\s\S]*?''\}/g, '{{currencyExchangeContext}}');
    p = p.replace(/\$\{chat\.settings\.enableDynamicCurrency[\s\S]*?注意：你可以自由选择货币[\s\S]*?''\}/g, '');
    p = p.replace(/\$\{historySlice[\s\S]*?join\('\\n'\)\}/g, '{{historySliceStr}}');
    p = p.replace(/\$\{membersWithContacts\}/g, '{{membersWithContacts}}');
    p = p.replace(/\$\{membersList\}/g, '{{membersList}}');
    p = p.replace(/\$\{longTermMemoryContext\}/g, '{{longTermMemoryContext}}');
    p = p.replace(/\$\{linkedMemoryContext\}/g, '{{linkedMemoryContext}}');
    p = p.replace(/\$\{presetContext\}/g, '{{presetContext}}');
    p = p.replace(/\$\{minLength\}/g, '{{minLength}}');
    p = p.replace(/\$\{maxLength\}/g, '{{maxLength}}');
    p = p.replace(/\$\{formatRules\}/g, '{{formatRules}}');
    p = p.replace(/\$\{userDisplayNameForAI\}/g, '{{userDisplayNameForAI}}');
    p = p.replace(/\$\{recentHistory\}/g, '{{recentHistory}}');
    p = p.replace(/\$\{auctionContext\}/g, '{{auctionContext}}');
    p = p.replace(/\$\{charList\}/g, '{{charList}}');
    p = p.replace(/\$\{truthGameHistoryContext\}/g, '{{truthGameHistoryContext}}');
    p = p.replace(/\$\{question\}/g, '{{question}}');
    p = p.replace(/\$\{userPersona\}/g, '{{userPersona}}');
    p = p.replace(/\$\{shortTermMemoryContext\}/g, '{{shortTermMemoryContext}}');
    p = p.replace(/\$\{mountedMemoryContext\}/g, '{{mountedMemoryContext}}');
    p = p.replace(/\$\{mainChatHistory\s*\|\|\s*'无'\}/g, '{{mainChatHistory}}');
    p = p.replace(/\$\{drawGuessHistory\s*\|\|\s*'无'\}/g, '{{drawGuessHistory}}');
    p = p.replace(/\$\{drawGuessHistory\s*\|\|\s*'（游戏刚开始）'\}/g, '{{drawGuessHistory}}');
    p = p.replace(/\$\{userNickname\}/g, '{{userNickname}}');
    p = p.replace(/\$\{canvasContentDescription\}/g, '{{canvasContentDescription}}');
    p = p.replace(/\$\{shortTermMemory\s*\|\|\s*'（暂无）'\}/g, '{{shortTermMemory}}');
    p = p.replace(/\$\{longTermMemory\s*\|\|\s*'（暂无）'\}/g, '{{longTermMemory}}');
    p = p.replace(/\$\{finalInstruction\}/g, '{{finalInstruction}}');
    p = p.replace(/\$\{new Date\(\)\.toLocaleDateString\('zh-CN'\)\}/g, '{{currentDate}}');

    // 针对任意剩余的 ${xxx}，仅匹配由字母、数字、下划线、小数点组成的变量，避免破坏复杂的脚本结构
    p = p.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, '{{$1}}');

    // 2. 将模板本身的 {{xxx}} 变量映射到 contextMap 真实数据。
    // 只替换一次：人设、世界书、线下预设等插入内容属于数据，不能再次作为模板执行。
    return p.replace(/\{\{([^{}]+)\}\}/g, (match, key) => {
      const k = key.trim();
      
      if (contextMap[k] !== undefined) return contextMap[k];
      
      // 支持自定义心声变量替换
      const activeChatId = state.activeChatId;
      if (activeChatId && state.chats[activeChatId]) {
        const currentChat = state.chats[activeChatId];
        if (currentChat.customThoughts && currentChat.customThoughts[k] !== undefined) {
          return currentChat.customThoughts[k];
        }
      }
      
      // 模糊匹配兜底（防用户写错变量名）
      if (k === 'chat.originalName') return contextMap['chat.originalName'] !== undefined ? contextMap['chat.originalName'] : match;
      if (k === 'chat.name') return contextMap['chat.name'] !== undefined ? contextMap['chat.name'] : match;
      if (k.includes('aiPersona')) return contextMap['aiPersona'] !== undefined ? contextMap['aiPersona'] : match;
      if (k.includes('worldBookContent')) return contextMap['worldBookContent'] !== undefined ? contextMap['worldBookContent'] : match;
      if (k.includes('getMemoryContextForPrompt')) return contextMap['memoryContextForPrompt'] !== undefined ? contextMap['memoryContextForPrompt'] : match;
      if (k.includes('myPersona')) return contextMap['myPersona'] !== undefined ? contextMap['myPersona'] : match;
      if (k.includes('userStatus')) return contextMap['userStatus'] !== undefined ? contextMap['userStatus'] : match;
      if (k.includes('timePerception') || k.includes('currentTime')) return contextMap['timePerceptionContext'] !== undefined ? contextMap['timePerceptionContext'] : match;
      if (k.includes('musicContext')) return contextMap['musicContextStr'] !== undefined ? contextMap['musicContextStr'] : match;
      if (k.includes('readingContext')) return contextMap['readingContextStr'] !== undefined ? contextMap['readingContextStr'] : match;
      if (k.includes('aiAvatarLibrary')) return contextMap['aiAvatarLibrary'] !== undefined ? contextMap['aiAvatarLibrary'] : match;
      if (k.includes('myAvatarLibrary')) return contextMap['myAvatarLibrary'] !== undefined ? contextMap['myAvatarLibrary'] : match;
      if (k === 'char_avatar') return contextMap['char_avatar'] !== undefined ? contextMap['char_avatar'] : match;
      if (k === 'user_avatar') return contextMap['user_avatar'] !== undefined ? contextMap['user_avatar'] : match;
      if (k === 'char_name') return contextMap['char_name'] !== undefined ? contextMap['char_name'] : match;
      if (k === 'char_remark') return contextMap['char_remark'] !== undefined ? contextMap['char_remark'] : match;
      if (k === 'user_name') return contextMap['user_name'] !== undefined ? contextMap['user_name'] : match;
      if (k === 'user_nickname') return contextMap['user_nickname'] !== undefined ? contextMap['user_nickname'] : match;
      if (k.includes('myNickname')) return contextMap['myNickname'] !== undefined ? contextMap['myNickname'] : match;
      
      return match;
    });
  }

