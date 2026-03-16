(function initAssistantRuntime(global) {
  const TARGETS = [
    { value: '虚拟电厂_24h15min_数据_agent.csv', label: 'data/虚拟电厂_24h15min_数据_agent.csv' },
    { value: 'output/Load_forecast_12h_agent.csv', label: 'data/output/Load_forecast_12h_agent.csv' },
    { value: 'output/PV_forecast_12h_agent.csv', label: 'data/output/PV_forecast_12h_agent.csv' },
  ];

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  function buildAttachmentContext(attachments) {
    if (!attachments.length) return '';
    return attachments.map((item, index) => [
      `【文件${index + 1}】${item.name}`,
      `来源：${item.source}`,
      `大小：${item.sizeLabel}${item.truncated ? '（已截断）' : ''}`,
      '内容：',
      item.text,
    ].join('\n')).join('\n\n');
  }

  function createSuggestion(id, title, body, action, severity, actionLabel) {
    return { id, title, body, action, severity, actionLabel };
  }

  function createRuntime(options = {}) {
    const bridge = options.bridge || global.DashboardAssistantBridge || null;
    const store = global.AssistantState.createStore();
    const tools = global.AssistantTools.createAssistantTools({
      dashboardProvider: () => (bridge && typeof bridge.getSnapshot === 'function' ? bridge.getSnapshot() : null),
    });
    const ui = global.AssistantUI.createAssistantUI();
    const observerSuggestions = new Map();
    const plannerSuggestions = new Map();

    function getSnapshot() {
      return bridge && typeof bridge.getSnapshot === 'function' ? bridge.getSnapshot() : null;
    }

    function getCombinedSuggestions() {
      return [...observerSuggestions.values(), ...plannerSuggestions.values()];
    }

    function refreshSuggestions() {
      store.replaceSuggestions(getCombinedSuggestions());
    }

    function render(state) {
      ui.setStatus(state.status);
      ui.setBusy(state.busy);
      ui.renderMessages(state.messages);
      ui.renderFiles(state.attachments);
      ui.renderSuggestions(state.suggestions);
      ui.renderTasks(state.tasks);
      ui.renderApproval(state.pendingApproval);
    }

    store.subscribe(render);

    function addGreeting() {
      store.addMessage('assistant', '你好，我是项目内嵌智能助手。除了问答，我还会根据页面状态主动给建议，并能执行预测、决策和文件相关任务。', {
        includeInHistory: false,
      });
    }

    async function loadToolManifest() {
      const manifest = await tools.fetchToolManifest();
      store.setToolRegistry(manifest);
    }

    async function refreshHealth() {
      try {
        await tools.checkHealth();
        store.setStatus('已连接');
      } catch (error) {
        store.setStatus('未连接');
      }
      buildObserverSuggestions();
    }

    function buildObserverSuggestions() {
      observerSuggestions.clear();
      const snapshot = getSnapshot();
      if (store.state.status !== '已连接') {
        observerSuggestions.set('agent-offline', createSuggestion(
          'agent-offline',
          '本地 Agent 未连接',
          '当前无法执行规划、预测或决策。确认本地后端已启动后再执行自动化任务。',
          null,
          'warn',
          ''
        ));
      }
      if (!snapshot) {
        refreshSuggestions();
        return;
      }
      if (snapshot.forecast && !snapshot.forecast.ready) {
        observerSuggestions.set('forecast-missing', createSuggestion(
          'forecast-missing',
          '预测结果缺失',
          '页面尚未检测到 12h 预测结果，可以先自动运行预测。',
          { tool: 'runForecast', args: {} },
          'info',
          '运行预测'
        ));
      }
      if (snapshot.forecast && snapshot.forecast.ready && snapshot.decision && !snapshot.decision.ready) {
        observerSuggestions.set('decision-missing', createSuggestion(
          'decision-missing',
          '可以继续生成决策',
          '预测结果已存在，但 12h 决策文件还未生成，适合继续串联下一步。',
          { tool: 'runDecision', args: {} },
          'info',
          '生成决策'
        ));
      }
      if (snapshot.kpis && snapshot.kpis.price && Number(snapshot.kpis.price.max) >= 1) {
        observerSuggestions.set('price-high', createSuggestion(
          'price-high',
          '检测到电价峰值偏高',
          '当前筛选范围内电价峰值较高，建议查看决策结果是否已有储能套利空间。',
          { tool: 'summarizeCurrentDashboard', args: {} },
          'info',
          '生成摘要'
        ));
      }
      refreshSuggestions();
    }

    function syncDashboardState(snapshot) {
      store.setDashboard(snapshot || null);
      buildObserverSuggestions();
    }

    function createAbortController() {
      const controller = new AbortController();
      store.setActiveRun({
        id: global.AssistantState.createId('run'),
        controller,
      });
      return controller;
    }

    function clearActiveRun() {
      store.setActiveRun(null);
      store.setBusy(false);
    }

    function getToolMeta(name) {
      return store.state.toolRegistry.find((item) => item.name === name)
        || global.AssistantTools.DEFAULT_TOOL_DEFINITIONS.find((item) => item.name === name)
        || null;
    }

    function shouldRequireApproval(actions) {
      if (!actions.length) return false;
      const autonomy = store.state.autonomy;
      if (autonomy === 'suggest_only') return true;
      if (autonomy === 'confirm_first') return true;
      return actions.some((action) => {
        const tool = getToolMeta(action.tool);
        return action.requiresConfirmation || (tool && tool.requiresConfirmation);
      });
    }

    async function refreshAfterTool(toolName) {
      if (!bridge) return;
      if (toolName === 'runForecast') {
        await bridge.refreshForecast?.();
      } else if (toolName === 'runDecision') {
        await bridge.refreshDecision?.();
      } else if (toolName === 'writeAgentFile') {
        await bridge.refreshForecast?.();
        await bridge.refreshDecision?.();
      } else if (toolName === 'summarizeCurrentDashboard') {
        await bridge.refreshData?.();
      }
      syncDashboardState(getSnapshot());
    }

    async function executeActions(actions, reasonText, taskIds = []) {
      if (!actions.length) return;
      store.setBusy(true);
      const controller = createAbortController();
      const context = {
        messages: store.state.history.slice(),
      };
      try {
        for (let index = 0; index < actions.length; index += 1) {
          const action = actions[index];
          const meta = getToolMeta(action.tool);
          const existingTaskId = taskIds[index];
          let task = null;
          if (existingTaskId) {
            task = store.updateTask(existingTaskId, {
              title: action.title || (meta ? meta.label : action.tool),
              detail: action.detail || reasonText || '等待执行。',
              status: 'running',
            });
          }
          if (!task) {
            task = store.pushTask({
              title: action.title || (meta ? meta.label : action.tool),
              detail: action.detail || reasonText || '等待执行。',
              status: 'running',
            });
          }
          try {
            const result = await tools.executeTool(action.tool, action.args || {}, context, {
              signal: controller.signal,
            });
            store.updateTask(task.id, {
              status: 'success',
              detail: action.successMessage || result.summary || result.filename || '执行完成。',
              result,
            });
            if (action.tool === 'readDataFile' && result && result.text) {
              store.addAttachment({
                id: global.AssistantState.createId('attachment'),
                name: result.name,
                source: result.path,
                size: result.size,
                sizeLabel: formatBytes(result.size),
                text: result.text,
                truncated: result.truncated,
              });
              ui.setFileHint(`已读取：${result.path}`);
            }
            if (action.tool === 'summarizeCurrentDashboard' && result.summary) {
              store.addMessage('assistant', result.summary, { includeInHistory: false });
            }
            if (action.tool === 'writeAgentFile' && result.text) {
              store.addMessage('assistant', result.text, { includeInHistory: true });
            }
            await refreshAfterTool(action.tool);
          } catch (error) {
            const message = error && error.message ? error.message : String(error);
            store.updateTask(task.id, {
              status: controller.signal.aborted ? 'cancelled' : 'error',
              detail: message,
            });
            if (!controller.signal.aborted) {
              store.addMessage('assistant', `任务失败：${message}`, { includeInHistory: false });
            }
            break;
          }
        }
      } finally {
        clearActiveRun();
      }
    }

    function queueActions(actions, reasonText) {
      if (!actions.length) return;
      if (shouldRequireApproval(actions)) {
        const pendingTasks = [];
        actions.forEach((action) => {
          const meta = getToolMeta(action.tool);
          const task = store.pushTask({
            title: action.title || (meta ? meta.label : action.tool),
            detail: action.detail || reasonText || '等待执行。',
            status: 'awaiting_approval',
          });
          pendingTasks.push(task.id);
        });
        store.setPendingApproval({
          text: reasonText || '该任务包含需要确认的动作。是否继续执行？',
          actions,
          taskIds: pendingTasks,
        });
        return;
      }
      executeActions(actions, reasonText);
    }

    async function planFromMessage(content, options2 = {}) {
      plannerSuggestions.clear();
      store.setBusy(true);
      try {
        const snapshot = getSnapshot();
        const attachmentContext = buildAttachmentContext(store.state.attachments);
        const payload = {
          messages: store.state.history.slice(),
          user_message: content,
          dashboard: snapshot,
          attachments: store.state.attachments.map((item) => ({
            name: item.name,
            source: item.source,
            text: item.text,
          })),
          attachment_context: attachmentContext,
          autonomy: store.state.autonomy,
          forced_target: options2.forcedTarget || '',
          tools: store.state.toolRegistry,
        };
        const response = await tools.planAssist(payload);
        if (response.reply) {
          store.addMessage('assistant', response.reply, { includeInHistory: true });
        }
        (response.suggestions || []).forEach((item) => {
          plannerSuggestions.set(item.id || global.AssistantState.createId('suggestion'), item);
        });
        refreshSuggestions();
        const actions = Array.isArray(response.actions) ? response.actions : [];
        if (actions.length) {
          queueActions(actions, response.plan_summary || response.reply);
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        store.addMessage('assistant', `规划失败：${message}`, { includeInHistory: false });
      } finally {
        if (!store.state.activeRun) {
          store.setBusy(false);
        }
      }
    }

    async function sendChatMessage(content) {
      store.setBusy(true);
      try {
        const dashboardSummary = tools.formatDashboardSummary(getSnapshot());
        const attachmentContext = buildAttachmentContext(store.state.attachments);
        const payloadMessages = store.state.history.slice();
        const lastMessage = payloadMessages[payloadMessages.length - 1];
        const pendingUser = lastMessage && lastMessage.role === 'user' ? payloadMessages.pop() : null;
        if (dashboardSummary) {
          payloadMessages.push({
            role: 'system',
            content: `以下是当前页面摘要，仅供回答时参考：\n${dashboardSummary}`,
          });
        }
        if (attachmentContext) {
          payloadMessages.push({
            role: 'system',
            content: `以下是用户已上传或读取的文件内容，仅供回答时参考：\n${attachmentContext}`,
          });
        }
        if (pendingUser) {
          payloadMessages.push(pendingUser);
        } else if (content) {
          payloadMessages.push({ role: 'user', content });
        }
        const response = await tools.chat({
          messages: payloadMessages,
          temperature: 0.7,
          max_tokens: 512,
        });
        const reply = response.text || '(无返回)';
        store.addMessage('assistant', reply, { includeInHistory: true });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        store.addMessage('assistant', `请求失败：${message}`, { includeInHistory: false });
      } finally {
        store.setBusy(false);
      }
    }

    async function handleSend() {
      const content = ui.getInputValue();
      if (!content) return;
      ui.clearInput();
      store.addMessage('user', content, { includeInHistory: true });
      if (store.state.mode === 'chat') {
        await sendChatMessage(content);
      } else {
        await planFromMessage(content);
      }
    }

    async function handleLoadPath() {
      const path = ui.getPathValue();
      if (!path) {
        ui.setFileHint('请输入 data/ 下的文件路径。', true);
        return;
      }
      ui.setFileHint(`正在读取：${path}`);
      try {
        const result = await tools.executeTool('readDataFile', { path });
        store.addAttachment({
          id: global.AssistantState.createId('attachment'),
          name: result.name,
          source: result.path,
          size: result.size,
          sizeLabel: formatBytes(result.size),
          text: result.text,
          truncated: result.truncated,
        });
        ui.setFileHint(`已读取：${result.path}`);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        ui.setFileHint(`读取失败：${message}`, true);
      }
    }

    async function handleUploadFiles(files) {
      if (!files.length) return;
      ui.setFileHint('正在读取上传文件...');
      for (const file of files) {
        try {
          const rawText = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
            reader.readAsText(file);
          });
          const truncated = tools.truncateText(rawText);
          store.addAttachment({
            id: global.AssistantState.createId('attachment'),
            name: file.name,
            source: '本地上传',
            size: file.size,
            sizeLabel: formatBytes(file.size),
            text: truncated.text,
            truncated: truncated.truncated,
          });
          ui.setFileHint(`已读取：${file.name}`);
        } catch (error) {
          ui.setFileHint(`读取失败：${file.name}`, true);
        }
      }
      ui.clearFileInput();
    }

    async function handleWriteTarget() {
      const prompt = ui.getInputValue();
      const target = ui.getTargetValue();
      if (!prompt) {
        ui.setFileHint('请先输入要生成或修正的内容。', true);
        return;
      }
      if (!target) {
        ui.setFileHint('请选择一个写入目标文件。', true);
        return;
      }
      ui.clearInput();
      store.addMessage('user', prompt, { includeInHistory: true });
      const action = {
        tool: 'writeAgentFile',
        title: '写入 Agent 文件',
        detail: `目标文件：${target}`,
        args: {
          targetPath: target,
          prompt,
        },
        requiresConfirmation: true,
      };
      queueActions([action], `助手准备将结果写入 ${target}。根据当前自治边界，这一步需要确认。`);
    }

    function handleClear() {
      store.resetConversation();
      ui.setFileHint('已清空对话、建议、任务和附件。');
      addGreeting();
      buildObserverSuggestions();
    }

    function handleApprove() {
      const pending = store.state.pendingApproval;
      if (!pending) return;
      store.setPendingApproval(null);
      executeActions(pending.actions || [], pending.text, pending.taskIds || []);
    }

    function handleReject() {
      const pending = store.state.pendingApproval;
      if (!pending) return;
      (pending.actions || []).forEach((action, index) => {
        const taskId = (pending.taskIds || [])[index];
        if (taskId) {
          store.updateTask(taskId, {
            title: action.title || action.tool,
            detail: '用户拒绝执行该动作。',
            status: 'cancelled',
          });
          return;
        }
        store.pushTask({
          title: action.title || action.tool,
          detail: '用户拒绝执行该动作。',
          status: 'cancelled',
        });
      });
      store.setPendingApproval(null);
      store.addMessage('assistant', '已取消待确认动作。', { includeInHistory: false });
    }

    function handleCancelRun() {
      const activeRun = store.state.activeRun;
      if (!activeRun || !activeRun.controller) return;
      activeRun.controller.abort();
      store.addMessage('assistant', '已请求中断当前自动执行。', { includeInHistory: false });
      clearActiveRun();
    }

    function handleSuggestionAction(suggestionId) {
      const suggestion = store.state.suggestions.find((item) => item.id === suggestionId);
      if (!suggestion || !suggestion.action) return;
      queueActions([{
        tool: suggestion.action.tool,
        args: suggestion.action.args || {},
        title: suggestion.title,
        detail: suggestion.body,
      }], suggestion.body);
    }

    ui.setTargetOptions(TARGETS);
    ui.bind({
      onApprove: handleApprove,
      onAutonomyChange: (value) => store.setAutonomy(value),
      onCancelRun: handleCancelRun,
      onClear: handleClear,
      onLoadPath: handleLoadPath,
      onModeChange: (value) => store.setMode(value),
      onReject: handleReject,
      onRemoveAttachment: (id) => {
        store.removeAttachment(id);
        ui.setFileHint('已更新文件列表。');
      },
      onSend: handleSend,
      onSuggestionAction: handleSuggestionAction,
      onUploadFiles: handleUploadFiles,
      onWriteTarget: handleWriteTarget,
    });

    addGreeting();
    store.setMode(ui.getMode());
    store.setAutonomy(ui.getAutonomy());
    loadToolManifest();
    syncDashboardState(getSnapshot());
    refreshHealth();
    global.addEventListener('dashboard:state', (event) => {
      syncDashboardState(event.detail || null);
    });
    global.setInterval(refreshHealth, 15000);

    return {
      store,
      tools,
    };
  }

  global.AssistantRuntime = {
    createRuntime,
  };
})(window);
