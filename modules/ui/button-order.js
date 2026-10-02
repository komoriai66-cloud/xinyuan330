// ============================================================
// 按钮排序编辑器 (原 script.js 第 48160~48348 行)
// ============================================================

  function renderButtonOrderEditor() {
    const editor = document.getElementById('button-order-editor');
    if (!editor) return;

    editor.innerHTML = '';



    let buttonOrder = state.globalSettings.chatActionButtonsOrder || DEFAULT_BUTTON_ORDER;
    buttonOrder = [...buttonOrder, ...['generation-adjustments-btn', 'model-communication-btn'].filter(id => !buttonOrder.includes(id))];

    buttonOrder.forEach(buttonId => {
      const originalButton = document.getElementById(buttonId);
      if (originalButton) {
        const item = document.createElement('div');
        item.className = 'draggable-button-item';
        item.draggable = true;
        item.dataset.buttonId = buttonId;
        item.innerHTML = originalButton.innerHTML;
        editor.appendChild(item);
      }
    });
  }



  function initializeButtonOrderEditor() {
    const editor = document.getElementById('button-order-editor');
    if (!editor) return;

    let draggingItem = null;


    const handleDragStart = (e) => {
      const target = e.target.closest('.draggable-button-item');
      if (!target) return;

      draggingItem = target;
      draggingItem.classList.add('dragging');


      if (e.cancelable) e.preventDefault();
    };

    const handleDragMove = (e) => {
      if (!draggingItem) return;


      const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;

      const afterElement = getDragAfterElement(editor, clientX);

      if (afterElement == null) {
        editor.appendChild(draggingItem);
      } else {
        editor.insertBefore(draggingItem, afterElement);
      }
    };

    const handleDragEnd = () => {
      if (!draggingItem) return;

      draggingItem.classList.remove('dragging');
      draggingItem = null;


      saveButtonOrder();
    };



    editor.addEventListener('mousedown', handleDragStart);
    editor.addEventListener('touchstart', handleDragStart, {
      passive: false
    });


    editor.addEventListener('mousemove', handleDragMove);
    editor.addEventListener('touchmove', handleDragMove, {
      passive: false
    });


    editor.addEventListener('mouseup', handleDragEnd);
    editor.addEventListener('mouseleave', handleDragEnd);
    editor.addEventListener('touchend', handleDragEnd);
  }



  function getDragAfterElement(container, x) {

    const draggableElements = [...container.querySelectorAll('.draggable-button-item:not(.dragging)')];


    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();

      const offset = x - box.left - box.width / 2;


      if (offset < 0 && offset > closest.offset) {
        return {
          offset: offset,
          element: child
        };
      } else {
        return closest;
      }
    }, {
      offset: Number.NEGATIVE_INFINITY
    }).element;
  }


  async function saveButtonOrder() {
    const editor = document.getElementById('button-order-editor');
    const newOrder = Array.from(editor.querySelectorAll('.draggable-button-item')).map(item => item.dataset.buttonId);

    state.globalSettings.chatActionButtonsOrder = newOrder;
    await db.globalSettings.put(state.globalSettings);



  }


  function applyButtonOrder() {
    const buttonOrder = state.globalSettings.chatActionButtonsOrder;
    if (!buttonOrder || !Array.isArray(buttonOrder) || buttonOrder.length === 0) {
      return;
    }

    const container = document.getElementById('chat-input-actions-top');
    if (!container) return;


    buttonOrder.forEach(buttonId => {
      const button = document.getElementById(buttonId);
      if (button) {
        container.appendChild(button);
      }
    });
  }



  const DEFAULT_BUTTON_ORDER = [
    'open-sticker-panel-btn', 'send-photo-btn', 'camera-capture-btn', 'upload-image-btn',
    'transfer-btn', 'voice-message-btn', 'voice-record-btn', 'send-waimai-request-btn',
    'video-call-btn', 'group-video-call-btn', 'voice-call-btn', 'group-voice-call-btn', 'send-poll-btn',
    'share-link-btn', 'share-location-btn', 'gomoku-btn',
    'open-shopping-btn', 'pat-btn', 'edit-last-response-btn',
    'regenerate-btn', 'generation-adjustments-btn', 'model-communication-btn', 'propel-btn', 'show-announcement-board-btn',
    'werewolf-game-btn',

    'read-together-btn',
    'open-truth-game-btn',
    'open-watch-together-btn',
    'open-nai-gallery-btn',
    'open-todo-list-btn',
    'open-quick-reply-btn',
    'narration-btn',
    'stop-api-call-btn'
  ];


  async function resetButtonOrder() {

    state.globalSettings.chatActionButtonsOrder = null;
    await db.globalSettings.put(state.globalSettings);


    renderButtonOrderEditor();


    applyButtonOrder();


    await showCustomAlert("成功", "按钮顺序已恢复为默认设置！");
  }


