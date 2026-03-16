(function initAssistantState(global) {
  const SYSTEM_PROMPT = [
    '你是一个项目内嵌智能助手。',
    '你的目标是先理解当前页面和数据状态，再给出建议或规划动作。',
    '除非工具定义明确允许，否则不要假设自己已经执行了操作。',
    '回答要简洁、透明，并说明下一步。'
  ].join('\n');

  function createId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function createStore() {
    const state = {
      status: '未连接',
      mode: 'agent',
      autonomy: 'auto_safe',
      busy: false,
      dashboard: null,
      toolRegistry: [],
      messages: [],
      history: [{ role: 'system', content: SYSTEM_PROMPT }],
      attachments: [],
      suggestions: [],
      tasks: [],
      pendingApproval: null,
      activeRun: null,
    };

    const listeners = new Set();

    function notify() {
      listeners.forEach((listener) => listener(state));
    }

    function subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    }

    function setStatus(status) {
      state.status = status;
      notify();
    }

    function setBusy(busy) {
      state.busy = Boolean(busy);
      notify();
    }

    function setMode(mode) {
      state.mode = mode;
      notify();
    }

    function setAutonomy(autonomy) {
      state.autonomy = autonomy;
      notify();
    }

    function setDashboard(dashboard) {
      state.dashboard = dashboard;
      notify();
    }

    function setToolRegistry(toolRegistry) {
      state.toolRegistry = Array.isArray(toolRegistry) ? toolRegistry.slice() : [];
      notify();
    }

    function addMessage(role, content, options = {}) {
      const message = {
        id: createId('msg'),
        role,
        content,
        createdAt: Date.now(),
        kind: options.kind || 'chat',
      };
      state.messages.push(message);
      if (options.includeInHistory !== false && (role === 'user' || role === 'assistant' || role === 'system')) {
        state.history.push({ role, content });
      }
      notify();
      return message;
    }

    function replaceSuggestions(suggestions) {
      state.suggestions = Array.isArray(suggestions) ? suggestions.slice() : [];
      notify();
    }

    function setPendingApproval(pendingApproval) {
      state.pendingApproval = pendingApproval;
      notify();
    }

    function setActiveRun(activeRun) {
      state.activeRun = activeRun;
      notify();
    }

    function resetConversation() {
      state.messages = [];
      state.history = [{ role: 'system', content: SYSTEM_PROMPT }];
      state.attachments = [];
      state.suggestions = [];
      state.tasks = [];
      state.pendingApproval = null;
      state.activeRun = null;
      notify();
    }

    function addAttachment(payload) {
      state.attachments.push(payload);
      notify();
    }

    function removeAttachment(id) {
      const next = state.attachments.filter((item) => item.id !== id);
      state.attachments = next;
      notify();
    }

    function clearAttachments() {
      state.attachments = [];
      notify();
    }

    function pushTask(task) {
      const nextTask = {
        id: task.id || createId('task'),
        status: task.status || 'planned',
        createdAt: task.createdAt || Date.now(),
        ...task,
      };
      state.tasks.push(nextTask);
      notify();
      return nextTask;
    }

    function updateTask(id, patch) {
      const index = state.tasks.findIndex((task) => task.id === id);
      if (index < 0) return null;
      state.tasks[index] = {
        ...state.tasks[index],
        ...patch,
      };
      notify();
      return state.tasks[index];
    }

    function clearCompletedTasks() {
      state.tasks = state.tasks.filter((task) => ['running', 'planned', 'awaiting_approval'].includes(task.status));
      notify();
    }

    return {
      state,
      subscribe,
      addMessage,
      addAttachment,
      clearAttachments,
      clearCompletedTasks,
      pushTask,
      removeAttachment,
      replaceSuggestions,
      resetConversation,
      setActiveRun,
      setAutonomy,
      setBusy,
      setDashboard,
      setMode,
      setPendingApproval,
      setStatus,
      setToolRegistry,
      updateTask,
    };
  }

  global.AssistantState = {
    SYSTEM_PROMPT,
    createId,
    createStore,
  };
})(window);
