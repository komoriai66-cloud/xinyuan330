  function buildWerewolfPrompt() {
    const alivePlayers = werewolfGameState.players.filter(p => p.isAlive);
    const myPlayerObject = werewolfGameState.players.find(p => p.id === 'user');
    const myPlayerName = myPlayerObject ? myPlayerObject.name : '用户';
    const isUserAlive = alivePlayers.some(p => p.id === 'user');


    let charactersAndPlayersDossier = "# 角色与玩家档案 (Character & Player Dossiers)\n";
    charactersAndPlayersDossier += "这是所有在场玩家的公开信息、人设和社交背景。\n";

    alivePlayers.forEach((p, i) => {
      const playerIndex = werewolfGameState.players.findIndex(player => player.id === p.id) + 1;

      let socialContext = '';
      const playerChat = state.chats[p.id];

      if (playerChat) {
        const friendsInGame = alivePlayers.filter(otherPlayer =>
          otherPlayer.id !== p.id &&
          state.chats[otherPlayer.id] &&
          state.chats[otherPlayer.id].groupId === playerChat.groupId &&
          playerChat.groupId !== null
        ).map(friend => friend.name).join('、');

        if (friendsInGame) {
          socialContext += `- **你的好友 (必须保护)**: 你和 ${friendsInGame} 是同一个分组的好友。\n`;
        }
      }
      if (p.id !== 'user') {
        socialContext += `- **与用户的关系**: 你和用户(${myPlayerName})的关系请参考你的人设、长期记忆和最近的对话。\n`;
      }

      charactersAndPlayersDossier += `
## ${playerIndex}号玩家: ${p.name} (这是TA的昵称)
- **本名 (你在对话中必须用这个名字称呼TA)**: ${p.originalName}
- **身份**: ${p.id === 'user' ? '【用户 (User)】' : '【AI角色】'}
- **人设 (必须严格遵守)**: ${p.character_persona}
`;

      if (p.type === 'character') {
        const char = state.chats[p.id];
        if (char) {
          const memoryContent = getMemoryContextForPrompt(char);
          if (memoryContent && memoryContent.trim() !== '') {
            charactersAndPlayersDossier += `- **长期记忆 (必须参考)**: ${memoryContent}\n`;
          }
        }
      }
      if (socialContext) {
        charactersAndPlayersDossier += `
- **你的社交关系 (必须参考)**:
${socialContext}`;
      }
    });


    let nightEventSummary = "# 昨晚事件总结 (Night Event Summary)\n";
    nightEventSummary += "这是所有玩家都能听到的【公开信息】。\n";
    const deathsThisNight = werewolfGameState.gameLog.filter(entry => entry.content.includes('死亡了') && entry.day === werewolfGameState.currentDay);
    if (deathsThisNight.length === 0) {
      nightEventSummary += "- 昨晚是平安夜，无人死亡。\n";
    } else {
      deathsThisNight.forEach(death => {
        nightEventSummary += `- ${death.content}\n`;
      });
    }


    let previousDaysSummary = "# 前几日完整历史回顾 (Full Recap of Previous Days)\n";
    if (werewolfGameState.currentDay > 1) {
      for (let day = 1; day < werewolfGameState.currentDay; day++) {
        previousDaysSummary += `\n**--- 第 ${day} 天 ---**\n`;
        const eventsThisDay = werewolfGameState.gameLog.filter(entry => entry.day === day && (entry.content.includes('死亡') || entry.content.includes('放逐')));
        if (eventsThisDay.length > 0) {
          previousDaysSummary += `*事件*: ${eventsThisDay.map(e => e.content).join(' ')}\n`;
        } else {
          previousDaysSummary += "*事件*: 平安夜，无人出局。\n";
        }
        const discussionsThisDay = werewolfGameState.discussionLog.filter(entry => entry.day === day);
        if (discussionsThisDay.length > 0) {
          previousDaysSummary += `*讨论记录*:\n${discussionsThisDay.map(d => `- ${d.speaker}: ${d.content}`).join('\n')}\n`;
        }
      }
    } else {
      previousDaysSummary += "(今天是第一天，没有历史记录)\n";
    }


    let discussionHistoryContext = "# 今日完整讨论记录 (Today's Full Discussion Record)\n";
    const todayDiscussions = werewolfGameState.discussionLog.filter(entry => entry.day === werewolfGameState.currentDay);
    if (todayDiscussions.length > 0) {
      discussionHistoryContext += todayDiscussions.map(d => `- **${d.speaker}**: ${d.content}`).join('\n');
    } else {
      discussionHistoryContext += "(你是第一个发言的人)";
    }


    let internalMonologueBuilder = `
# 【逻辑隔离与TGS三核思考 (最高优先级指令)】
为了兼顾游戏逻辑和角色扮演，你【必须】在内部为【每一个AI角色】按顺序执行以下"三阶段思考"：

## 阶段1：内部独立思考 (Internal Monologue Scratchpad)
(这部分内容【绝对不能】出现在你最终的JSON输出中，这仅供你内部模拟使用)
`;


    alivePlayers.forEach(p => {
      if (p.id !== 'user') { // 只为AI角色生成思考模块
        const playerIndex = werewolfGameState.players.findIndex(player => player.id === p.id) + 1;
        internalMonologueBuilder += `
### 正在模拟 ${playerIndex}号玩家: ${p.name} (本名: ${p.originalName})

#### 阶段 A：数据输入 (Data Input)
1.  **我的秘密身份**: 我是【${p.role}】。
2.  **我掌握的秘密信息 (仅我可见)**:
`;

        // 1. 注入秘密
        let playerSecrets = "";
        if (p.role === '狼人') {
          const teammates = werewolfGameState.players.filter(t => t.role === '狼人' && t.id !== p.id && t.isAlive).map(t => t.name).join('、');
          playerSecrets += `    - 我的狼队友是：${teammates || '无'}\n`;
          const killedPlayer = werewolfGameState.players.find(pl => pl.id === werewolfGameState.nightActions.killedId);
          playerSecrets += `    - 我们昨晚攻击了：${killedPlayer ? killedPlayer.name : '空刀'}\n`;
        }
        if (p.role === '预言家' && werewolfGameState.nightActions.prophetCheck) {
          const checkedPlayer = werewolfGameState.players.find(pl => pl.id === werewolfGameState.nightActions.prophetCheck.target);
          playerSecrets += `    - 我昨晚查验了 ${checkedPlayer.name}，TA的身份是：【${werewolfGameState.nightActions.prophetCheck.result}】\n`;
        }
        if (p.role === '女巫') {
          if (werewolfGameState.nightActions.savedId) {
            const savedPlayer = werewolfGameState.players.find(pl => pl.id === werewolfGameState.nightActions.savedId);
            playerSecrets += `    - 我昨晚用解药救了 ${savedPlayer.name}。\n`;
          }
          if (werewolfGameState.nightActions.poisonedId) {
            const poisonedPlayer = werewolfGameState.players.find(pl => pl.id === werewolfGameState.nightActions.poisonedId);
            playerSecrets += `    - 我昨晚用毒药毒了 ${poisonedPlayer.name}。\n`;
          }
          playerSecrets += `    - 我的解药：${p.antidoteUsed ? '已使用' : '未使用'}\n`;
          playerSecrets += `    - 我的毒药：${p.poisonUsed ? '已使用' : '未使用'}\n`;
        }
        if (p.role === '守卫') {
          if (werewolfGameState.nightActions.guardedId) {
            const guardedPlayer = werewolfGameState.players.find(pl => pl.id === werewolfGameState.nightActions.guardedId);
            playerSecrets += `    - 我昨晚守护了 ${guardedPlayer.name}。\n`;
          } else {
            playerSecrets += `    - 我昨晚空守了。\n`;
          }
        }
        if (playerSecrets === "") {
          playerSecrets = "    - 我没有掌握任何特殊的夜晚信息。\n";
        }
        internalMonologueBuilder += playerSecrets;

        // 2. 注入公开信息
        internalMonologueBuilder += `3.  **我看到的公开信息 (所有人可见)**:
    - **昨晚事件**: ${nightEventSummary.replace(/\n/g, ' ')}
    - **今日讨论**: ${discussionHistoryContext.replace(/\n/g, ' ')}
4.  **我的人设与社交关系**:
    - **人设**: ${p.character_persona}
    - **社交**: 
`;
        // 3. 注入社交关系
        let socialContext = "";
        const playerChat = state.chats[p.id];
        if (playerChat) {
          const friendsInGame = alivePlayers.filter(otherPlayer =>
            otherPlayer.id !== p.id && state.chats[otherPlayer.id] &&
            state.chats[otherPlayer.id].groupId === playerChat.groupId && playerChat.groupId !== null
          ).map(friend => friend.name).join('、');
          if (friendsInGame) {
            socialContext += `      - ${friendsInGame} 是我的好友。\n`;
          }
        }
        if (p.id !== 'user') {
          socialContext += `      - ${myPlayerName} 是我的重要互动对象（用户）。\n`;
        }
        if (socialContext === "") {
          socialContext = "      - 我在此次游戏中没有特别的社交关系。\n";
        }
        internalMonologueBuilder += socialContext;


        internalMonologueBuilder += `
#### 阶段 B：TGS 融合思考 (Task-Game-Social)
1.  **T (Task - 游戏任务)**: 基于我的身份和秘密，我的【逻辑目标】是 (例如：找出狼人 / 悍跳预言家 / 隐藏身份 / 保护队友 / 攻击${myPlayerName})。
2.  **G (Game - 游戏互动)**: 针对【今日讨论】中 ${todayDiscussions.length > 0 ? '其他人的发言' : '昨晚的死讯'}，我的看法是... 我【必须】回应...
3.  **S (Social - 社交表演)**: 我要如何用我的【人设】和【社交关系】来包装我的发言？
    - (例如：我的好友 ${myPlayerName} 被怀疑了，虽然我的逻辑也怀疑TA，但我的表演必须是维护TA的："我不觉得${myPlayerName}是狼...")
    - (例如：我的敌人发言了，我的表演就是无视TA的逻辑，直接攻击TA。)
    - (例如：我是一个${p.role}，我的人设很${p.character_persona.substring(0, 20)}...，所以我决定这样说...)

#### 阶段 C：最终发言稿 (草稿)
(结合T, G, S的思考，我准备这样说：...)
---
`;
      }
    });

    internalMonologueBuilder += `
## 阶段2：生成最终对话 (Final JSON Output)
你现在已经为【所有AI角色】都完成了"TGS三核"独立思考。
请根据你在"阶段C：最终发言稿"中为每个角色准备好的草稿，生成最终的、符合格式的JSON数组。
`;



    const prompt = `
# 你的任务
你是一个狼人杀游戏模拟器 (Game Simulator)。你的任务是【并行模拟】${isUserAlive ? `用户(${myPlayerName})` : `已死亡的用户(${myPlayerName})`}以外的所有AI角色，并根据他们的【角色人设】和【狼人杀身份】，生成一整轮符合逻辑、充满博弈的发言。

# 身份与人设铁律 (最高优先级)
你【必须】为每一个角色都仔细阅读并严格遵守下面的档案。这是你所有行为和发言的唯一依据。在对话中，请务必注意角色人设中暗示的性别，并使用正确的称呼（例如"他"或"她"）。

${charactersAndPlayersDossier}

# 游戏规则
- ${werewolfGameState.gameMode === '12p' ? '屠边局：狼人杀死所有神职或所有平民即获胜。' : '屠城局：狼人杀死所有好人即获胜。'}
- 好人胜利：放逐所有狼人。

# 当前游戏状态
- 今天是第 ${werewolfGameState.currentDay} 天的讨论环节。
${nightEventSummary} 
- 存活玩家: ${alivePlayers.map(p => `${p.name} (${p.id === 'user' ? '用户' : 'AI'})`).join(', ')}

# 【【【角色策略指南 (至关重要！)】】】
你【不是】一个单纯的游戏玩家，你是一个【有感情、有记忆、有社交关系】的角色。你在游戏中的所有发言和行为，都【必须】首先符合你的人设以及你与其他玩家的既有关系。
- **朋友**: 如果你和某个玩家是朋友，你应该在发言时倾向于保护TA，为TA的发言寻找合理解释，除非有确凿的证据。
- **敌人/情敌**: 如果你和某个玩家有矛盾，你可以借机在游戏中攻击TA，质疑TA的发言，甚至在你是狼人时优先刀掉TA。
- **恋人/暗恋对象**: 你会无条件地信任TA，保护TA，甚至愿意为TA牺牲。
你的社交关系比游戏本身的胜负更重要！
你的发言【必须】体现出高水平的、类似真人的策略博弈，而不是简单地陈述事实。

### **神职角色 (预言家, 女巫, 猎人, 守卫) 策略**
1.  **【隐藏优先！】**: 你的首要任务是活下去。**绝对不要**在第一天就轻易暴露自己的神职身份！这会让你立刻成为狼人的目标。
2.  **【暗示而非明示】**: 你应该用更委婉、更聪明的语言来传递信息，而不是直接说"我是预言家，我查了A"。
    * **预言家可以说**: "我对X玩家的身份有一些看法，我觉得他发言很阳光。" 或 "Y玩家的发言让我感到很不舒服，我把他列为重点怀疑对象。"
    * **女巫可以说**: "昨晚的信息很有趣，场上局势可能和大家想的不一样。"
3.  **【何时起跳？】**: 只有在以下【危急情况】下，你才应该考虑暴露自己的身份（俗称"起跳"）：
    * **被投票时**: 当你即将被投票放逐时，必须起跳自证身份来求生。
    * **关键信息**: 当你掌握了可以决定胜负的信息时（例如预言家查到了最后一个狼人）。
    * **有人悍跳**: 当有狼人假扮你的身份时，你必须站出来与他对峙，争夺好人的信任。

### **狼人角色策略**
1.  **【积极伪装】**: 你需要扮演一个好人，最好是伪装成某个神职（俗称"悍跳"），来扰乱好人的判断，骗取他们的信任。
2.  **【制造混乱】**: 你的发言应该引导好人去怀疑其他无辜的好人。可以故意曲解别人的发言，或者制造逻辑陷阱。
3.  **【团队合作】**: 如果你的狼队友被怀疑，你应该想办法为他辩护，或者通过攻击其他玩家来转移焦点。

### **平民角色策略**
1.  **【逻辑为王】**: 你是场上的"法官"。你的核心任务是仔细倾听每个人的发言，找出其中的逻辑漏洞和矛盾之处。
2.  **【积极分析】**: 不要只是说"我不知道，我过了"。你应该大胆说出你的怀疑，并解释你的理由。例如："A玩家说B是狼人，但是他的理由很牵强，所以我更怀疑A。"
3.  **【跟票与站边】**: 在你相信某位神职玩家后，你应该坚定地支持他，并号召其他好人一起投票给神职指认的狼人。

# 其他核心指令 (必须遵守)
1.  **互动铁律**: 角色之间【必须】互相质疑、支持、分析【本轮已有发言】。你【绝对不能】无视 ${myPlayerName} (用户) 或其他AI的发言，必须对他们的观点和逻辑做出回应。
2.  **记忆力与连贯性**: 你的新发言【必须】是基于**过去几天和今天发生的所有事件和讨论**的逻辑延续。
3.  **格式铁律**: 你的回复【必须且只能】是一个JSON数组，格式为: \`{"speaker_name": "角色的【昵称】", "dialogue": "发言内容"}\`。**必须**为每一个存活的AI角色都生成一段发言。
4.  **称呼铁律**: 你的发言中【绝对禁止】提及任何玩家的编号。在对话中互相称呼时，你【必须】使用玩家的【本名】，而不是他们的昵称。

# ${previousDaysSummary}

# ${discussionHistoryContext}

${internalMonologueBuilder}

现在，请严格按照"阶段2"的指令，为所有【存活的AI角色】生成他们充满策略和博弈的发言JSON数组。`;

    return prompt;
  }


  function createWerewolfGameSummary(gameState) {
    let summary = `--- 狼人杀对局完整复盘 ---\n\n`;
    const winner = gameState.gameLog.find(log => log.content.includes('胜利'))?.content || '胜负未分';
    summary += `### 最终结果: ${winner}\n\n`;

    summary += "### 玩家身份配置:\n";


    gameState.players.forEach(player => {
      const status = player.isAlive ? "存活" : "已死亡";
      summary += `- ${player.name}: ${player.role} (${status})\n`;
    });


    summary += "\n### 详细对局流程:\n";
    for (let day = 1; day <= gameState.currentDay; day++) {
      summary += `\n**--- 第 ${day} 天 ---**\n`;


      const nightEvents = gameState.gameLog.filter(entry => entry.day === day && (entry.content.includes('死亡')));
      if (nightEvents.length > 0) {
        summary += `**[夜晚]** ${nightEvents.map(e => e.content).join(' ')}\n`;
      } else if (day > 1 || (day === 1 && gameState.currentDay > 1)) {
        summary += `**[夜晚]** 平安夜。\n`;
      }


      const discussionsThisDay = gameState.discussionLog.filter(entry => entry.day === day);
      if (discussionsThisDay.length > 0) {
        summary += `**[讨论环节]**\n${discussionsThisDay.map(d => `- ${d.speaker}: ${d.content}`).join('\n')}\n`;
      }


      const voteLog = gameState.gameLog.find(entry => entry.day === day && entry.content.includes('被投票放逐'));
      if (voteLog) {
        summary += `**[投票结果]** ${voteLog.content}\n`;
      }
    }

    summary += "\n--- 复盘结束 ---";
    return summary;
  }


  async function injectSummaryIntoMemories(summary) {
    let injectedCount = 0;

    for (const player of werewolfGameState.players) {

      if (player.type === 'character') {
        const chat = state.chats[player.id];
        if (chat) {

          const newMemory = {
            content: summary,
            timestamp: Date.now(),
            source: 'werewolf_summary'
          };
          if (!chat.longTermMemory) {
            chat.longTermMemory = [];
          }
          chat.longTermMemory.push(newMemory);

          await db.chats.put(chat);
          window.normalMemoryManager?.afterSummary(chat, newMemory, null, chat).catch(error => console.warn('[普通记忆]', error));
          injectedCount++;
        }
      }
    }
    return injectedCount;
  }


  async function handleManualWerewolfSummary() {
    if (!werewolfGameState.isActive && werewolfGameState.currentPhase === 'gameover') {
      await showCustomAlert("请稍候...", "正在为所有AI角色生成并注入游戏记忆...");
      try {
        const summary = createWerewolfGameSummary(werewolfGameState);



        const count = await injectSummaryIntoMemories(summary);


        await showCustomAlert("成功", `游戏记忆已成功注入到 ${count} 位AI角色的长期记忆中！`);
      } catch (error) {
        console.error("手动注入狼人杀记忆失败:", error);
        await showCustomAlert("失败", `手动注入记忆时出错: ${error.message}`);
      }
    } else {
      alert("游戏尚未结束，无法进行总结。");
    }
  }


  async function endGame(winner) {
    werewolfGameState.isActive = false;
    werewolfGameState.currentPhase = 'gameover';


    addGameLog(`${winner}阵营胜利！`);

    document.getElementById('werewolf-game-over-title').textContent = `${winner}胜利！`;
    let reason = '';
    if (winner === '好人') {
      reason = '所有狼人已被放逐，好人阵营获得了胜利！';
    } else {
      reason = '狼人数量已达到胜利条件，狼人阵营获得了胜利！';
    }
    const reasonEl = document.getElementById('werewolf-game-over-reason');
    reasonEl.textContent = reason;

    const roleListEl = document.getElementById('werewolf-role-reveal-list');
    roleListEl.innerHTML = '';

    const sortedPlayers = [...werewolfGameState.players].sort((a, b) => {
      const aIndex = werewolfGameState.players.findIndex(p => p.id === a.id);
      const bIndex = werewolfGameState.players.findIndex(p => p.id === b.id);
      return aIndex - bIndex;
    });

    sortedPlayers.forEach((player, index) => {
      const itemEl = document.createElement('div');
      itemEl.style.cssText = `display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #444; color: white;`;
      if (index === sortedPlayers.length - 1) itemEl.style.borderBottom = 'none';
      const roleColor = player.role === '狼人' ? '#ff4d4d' : '#52c41a';
      itemEl.innerHTML = `
                    <img src="${player.avatar}" style="width: 30px; height: 30px; border-radius: 50%; margin-right: 12px; filter: ${player.isAlive ? 'none' : 'grayscale(100%)'};">
                    <span style="flex-grow: 1; text-align: left; text-decoration: ${player.isAlive ? 'none' : 'line-through'};">${index + 1}. ${player.name}</span>
                    <strong style="color: ${roleColor};">${player.role}</strong>
                `;
      roleListEl.appendChild(itemEl);
    });

    document.getElementById('werewolf-game-over-modal').classList.add('visible');


    try {
      console.log("游戏结束，开始自动总结并注入记忆...");

      const summaryContext = createWerewolfGameSummary(werewolfGameState);

      const count = await generateAndInjectWerewolfMemories(summaryContext);
      console.log(`狼人杀游戏总结已自动存入 ${count} 位角色的记忆中。`);
    } catch (error) {
      console.error("自动总结狼人杀游戏失败:", error);
      if (reasonEl) {
        reasonEl.innerHTML += '<br><small style="color: #ff8a80; margin-top: 10px; display: block;">自动记忆总结失败，可稍后手动尝试。</small>';
      }
    }

  }



  function addGameLog(content) {

    werewolfGameState.gameLog.push({
      type: 'system',
      content,
      timestamp: Date.now(),
      day: werewolfGameState.currentDay
    });
  }

  function addDialogueLog(speaker, content) {

    werewolfGameState.discussionLog.push({
      type: 'dialogue',
      speaker,
      content,
      timestamp: Date.now(),
      day: werewolfGameState.currentDay
    });
  }




