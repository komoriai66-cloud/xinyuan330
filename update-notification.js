// 更新弹窗管理器
class UpdateNotification {
  constructor() {
    this.storageKey = 'update_notification_dismissed';
    this.currentVersion = '10.2'; // 当前更新版本号
    this.countdownSeconds = 5;
    this.countdownInterval = null;
  }

  // 检查是否应该显示弹窗
  shouldShow() {
    const dismissedVersion = localStorage.getItem(this.storageKey);
    // 如果没有记录或者记录的版本不是当前版本，则显示弹窗
    return !dismissedVersion || dismissedVersion !== this.currentVersion;
  }

  // 创建弹窗HTML
  createNotificationHTML() {
    const updateContent = `
      <div style="margin-bottom: 15px;"><button id="update-clear-global-css-btn" style="width: 100%; padding: 10px; background: #ff4d4f; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">清除全局自定义CSS (防错位)</button></div>
      <div class="update-item important-note">新手必看：DC解答区 <a href="https://discord.com/channels/1379304008157499423/1443544486796853248" target="_blank" style="color: #4A9EFF;">点击前往</a></div>
      <div class="update-item important-note">强烈建议：安装到主屏幕以获得最佳体验</div>
      <div class="update-item important-note">注意：首次打开最好使用魔法</div>
      <div class="update-item tips">有任何问题请通过DC私信联系 <a href="https://discord.com/users/1353222930875551804" target="_blank" style="color: #4A9EFF;">点击前往</a>，其他渠道可能无法及时回复</div>
      <div class="update-item important-note">使用提示：请留意 API 设置页面的小人菜单，新增功能入口都在这里哦。</div>
      <div class="update-divider">10.2 更新日志</div>
      <div class="update-item">1. 升级渲染器功能：新增普通文字、关键词、整行、起止标记等匹配方式，支持随机替换、对照替换、格式整理，以及高亮、标签、折叠、卡片、遮罩等展示效果。</div>
      <div class="update-item">2. 完善渲染规则管理：新增搜索、分组、批量启停、调整执行顺序、暂时停用和撤销最近修改，支持测试预览、查看处理过程及保存测试样本。</div>
      <div class="update-item">3. 细化规则生效范围：可分别设置用户或角色消息、单聊或群聊、正文或心声，并选择在显示、发送给 AI、复制、文本导出时处理；支持保护代码块和链接。</div>
      <div class="update-item">4. 新增“和模型聊聊”：可以单独讨论角色回复哪里不合适、希望怎样调整，沟通内容独立保存，不作为角色剧情聊天记录。</div>
      <div class="update-item">5. 新增带意向重新生成：可填写要求或选择快捷标签，先生成候选回复，查看满意后再采用，也可撤销采用；群聊支持只调整指定成员的回复。</div>
      <div class="update-item">6. 新增生成偏好管理：调整要求可选择仅本次、下一次主动回复、当前聊天持续生效或全局持续生效，并支持编辑、启停和删除。</div>
      <div class="update-item">7. 修复重新生成失败后原回复丢失的问题，并避免重复点击同时发起多次重生成请求。</div>
      <div class="update-item">8. 新增音乐多人同步：一起听时可以选择多个角色，让他们同步感知歌曲、歌词及播放操作，分别累计实际参与的听歌时长。</div>
      <div class="update-item">9. 修复角色备注修改的提示词冲突：明确区分角色本名、当前备注，以及备注由用户还是角色修改，减少角色误认修改来源的问题。</div>
      <div class="update-item">10. 优化向量记忆提取：默认一次提交全部待处理消息，可自行开启分批并设置每批数量；新增精简、适量、详细三种记录程度。</div>
      <div class="update-item">11. 完善提取进度与恢复：显示处理进度、请求次数及接口返回的用量，支持暂停、继续和重试；失败后保留已成功保存的部分，避免重复提取或错误推进进度。</div>
      <div class="update-item">12. 优化记忆日期和事件判断：区分事件发生时间与保存时间，结合来源消息解释“昨天、明天”等相对日期；无依据时标记时间不明，减少将旧事件误记为今天的问题。</div>
      <div class="update-item">13. 优化记忆去重与计划更新：减少不同日期的相似经历被误合并，支持关联计划后续的完成、取消等状态，并保留更新记录。</div>
      <div class="update-item">14. 新增记忆日期修复与撤销：可按原文依据修复旧日期，修复前保存备份；支持批量平移日期及撤销上次调整。</div>
      <div class="update-item">15. 新增普通记忆梳理：可关联旧约定与后续结果，整理成角色概况；支持查看、编辑、选择应用建议和撤销操作，并设置自动整理或手动应用及不同读取方式。梳理使用总结接口，会产生 API 用量。</div>
      <div class="update-item">16. 新增记忆与世界时间联动：新消息可保存发送当时的世界时间，后续修改日期或延迟提取不会改写已保存的时间依据；支持独立时区、流逝倍率、暂停及时间线共享设置。</div>
      <div class="update-item">17. 新增 ElevenLabs 语音服务：角色可独立选择 MiniMax 或 ElevenLabs，支持获取、搜索、收藏音色，生成试听，以及保存声音参数预设；聊天语音和语音／视频通话均接入角色配置。</div>
      <div class="update-item">18. 完善语音播放与保存：新增可选流式播放、长文本分段、生成音频持久保存、重新生成及清理入口；多段语音可下载为 ZIP 音频包。</div>
      <div class="update-item">19. 修复语音相关问题：改善真实录音初始化异常、通话切换聊天后音色混用，以及消息编辑或删除后对应语音继续播放的问题。</div>
      <div class="update-item">20. 优化字体设置：支持明确切换默认、网络和本地字体来源，预览与正式设置分离；新增加载状态、失败提示、重新加载和退出未保存提醒，完善字体、字号应用范围及预设保存。</div>
      <div class="update-item">21. 修复字体恢复和缓存问题：改善本地字体重启恢复、旧外观导入、快速切换字体及重新加载仍使用旧缓存的情况。</div>
      <div class="update-item">22. 完善记忆备份与导入导出：新增概况、时间规则及相关记录随备份保存；修复相同时间戳记忆编辑、删除可能选错条目，以及精炼旧记忆后跳过尚未总结聊天的问题。</div>
      <div class="update-divider">共同更新 · 反馈中心试用</div>
      <div class="update-item">新增私密反馈和公开反馈入口，可提交建议、报错并附带截图；公开内容经审核后展示。作者回复后，可回到原浏览器查看并继续交流。</div>
      <div class="update-item tips">反馈投稿需要联网完成安全验证。中国大陆网络下，验证可能无法加载，投稿暂不保证稳定可用；遇到问题可稍后重试，或继续使用原有反馈渠道。</div>
    `;

    return `
      <div id="update-notification-overlay">
        <div id="update-notification-modal">
          <img src="https://img.baibai.cv/f/mwOEhK/retouch-2026013121094970.png" class="update-decoration-img">
          <div class="update-notification-header">
            <div class="update-title">10.2 更新</div>
          </div>
          
          <div class="update-notification-body">
            <div class="update-content">
              ${updateContent}
            </div>
          </div>
          
          <div class="update-notification-footer">
            <button id="update-btn-got-it" class="update-btn update-btn-primary" disabled>
              我知道了 (<span id="countdown">${this.countdownSeconds}</span>s)
            </button>
            <button id="update-btn-dont-show" class="update-btn update-btn-secondary" disabled>
              下次不要提示
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // 开始倒计时
  startCountdown() {
    let timeLeft = this.countdownSeconds;
    const countdownElement = document.getElementById('countdown');
    const btnGotIt = document.getElementById('update-btn-got-it');
    const btnDontShow = document.getElementById('update-btn-dont-show');

    this.countdownInterval = setInterval(() => {
      timeLeft--;
      if (countdownElement) {
        countdownElement.textContent = timeLeft;
      }

      if (timeLeft <= 0) {
        clearInterval(this.countdownInterval);
        // 启用按钮
        if (btnGotIt) {
          btnGotIt.disabled = false;
          btnGotIt.innerHTML = '我知道了';
          btnGotIt.classList.add('enabled');
        }
        if (btnDontShow) {
          btnDontShow.disabled = false;
          btnDontShow.classList.add('enabled');
        }
      }
    }, 1000);
  }

  // 关闭弹窗
  closeNotification() {
    const overlay = document.getElementById('update-notification-overlay');
    if (overlay) {
      overlay.classList.add('fade-out');
      setTimeout(() => {
        overlay.remove();
      }, 300);
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
  }

  // 点击"我知道了"
  handleGotIt() {
    // 不保存任何内容，下次刷新还会显示
    this.closeNotification();
  }

  // 点击"下次不要提示"
  handleDontShow() {
    // 保存当前版本号，下次不再显示
    localStorage.setItem(this.storageKey, this.currentVersion);
    this.closeNotification();
  }

  // 绑定事件
  bindEvents() {
    const btnGotIt = document.getElementById('update-btn-got-it');
    const btnDontShow = document.getElementById('update-btn-dont-show');

    if (btnGotIt) {
      btnGotIt.addEventListener('click', () => {
        if (!btnGotIt.disabled) {
          this.handleGotIt();
        }
      });
    }

    if (btnDontShow) {
      btnDontShow.addEventListener('click', () => {
        if (!btnDontShow.disabled) {
          this.handleDontShow();
        }
      });
    }

    // 清除全局 CSS 按钮事件
    const clearCssBtn = document.getElementById('update-clear-global-css-btn');
    if (clearCssBtn) {
      clearCssBtn.addEventListener('click', () => {
        // 1. 更新内存状态
        if (window.state && window.state.globalSettings) {
          window.state.globalSettings.globalCss = '';
          // 2. 更新数据库
          if (window.db && window.db.globalSettings) {
            window.db.globalSettings.put({ id: 1, ...window.state.globalSettings }).catch(console.error);
          }
        }
        // 3. 更新输入框（如果存在）
        const globalCssInput = document.getElementById('global-css-input');
        if (globalCssInput) globalCssInput.value = '';
        // 4. 清除页面上的样式标签
        const styleEl = document.getElementById('global-custom-style');
        if (styleEl) styleEl.textContent = '';
        
        // 5. 调用 applyGlobalCss 确保应用空样式
        if (typeof window.applyGlobalCss === 'function') {
          window.applyGlobalCss('');
        }
        
        // 6. 重新渲染聊天消息 (如果有激活的聊天)，确保气泡等恢复默认
        if (window.state && window.state.activeChatId && typeof window.renderMessages === 'function') {
            const chat = window.state.chats[window.state.activeChatId];
            if (chat) window.renderMessages(chat);
        }

        clearCssBtn.textContent = '✅ 已清除全局CSS';
        clearCssBtn.style.background = '#52c41a';
      });
    }

    // 防止点击弹窗内容时关闭
    const modal = document.getElementById('update-notification-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    // 🎯 紧急跳过功能：连续点击3次屏幕跳过弹窗
    this.setupEmergencySkip();
  }

  // 紧急跳过功能实现
  setupEmergencySkip() {
    const overlay = document.getElementById('update-notification-overlay');
    if (!overlay) return;

    let clickCount = 0;
    let clickTimer = null;

    overlay.addEventListener('click', (e) => {
      // 只在点击遮罩层时触发（不是点击弹窗内容）
      if (e.target !== overlay) return;

      clickCount++;

      // 清除之前的定时器
      if (clickTimer) {
        clearTimeout(clickTimer);
      }

      // 如果2秒内点击3次，触发跳过
      if (clickCount >= 3) {
        console.log('[UpdateNotification] 检测到紧急跳过手势');
        this.emergencySkip();
        clickCount = 0;
        return;
      }

      // 2秒后重置计数
      clickTimer = setTimeout(() => {
        clickCount = 0;
      }, 2000);
    });
  }

  // 紧急跳过方法
  emergencySkip() {
    // 显示跳过提示（可选）
    const modal = document.getElementById('update-notification-modal');
    if (modal) {
      const skipHint = document.createElement('div');
      skipHint.textContent = '已跳过更新通知';
      skipHint.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(255, 184, 197, 0.95);
        color: white;
        padding: 12px 24px;
        border-radius: 20px;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10;
        animation: skipHintAnim 0.4s ease;
      `;
      modal.appendChild(skipHint);

      // 添加动画样式
      if (!document.querySelector('#skip-hint-style')) {
        const style = document.createElement('style');
        style.id = 'skip-hint-style';
        style.textContent = `
          @keyframes skipHintAnim {
            from { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
            to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          }
        `;
        document.head.appendChild(style);
      }
    }

    // 0.5秒后关闭弹窗
    setTimeout(() => {
      this.closeNotification();
    }, 500);
  }

  // 显示弹窗
  show() {
    if (!this.shouldShow()) {
      return;
    }

    // 创建弹窗
    const notificationHTML = this.createNotificationHTML();
    document.body.insertAdjacentHTML('beforeend', notificationHTML);

    // 绑定事件
    this.bindEvents();

    // 开始倒计时
    this.startCountdown();

    // 添加显示动画
    setTimeout(() => {
      const overlay = document.getElementById('update-notification-overlay');
      if (overlay) {
        overlay.classList.add('show');
      }
    }, 100);
  }

  // 初始化
  init() {
    // 等待DOM加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        this.show();
      });
    } else {
      this.show();
    }
  }
}

// 创建实例并初始化
const updateNotification = new UpdateNotification();
updateNotification.init();
