(function initAssistantUI(global) {
  const STATUS_LABELS = {
    planned: '待执行',
    awaiting_approval: '待确认',
    running: '执行中',
    success: '已完成',
    error: '失败',
    cancelled: '已中断',
  };

  function createAssistantUI() {
    const refs = {
      approvalEl: document.getElementById('assistant-approval'),
      approvalTextEl: document.getElementById('assistant-approval-text'),
      approveEl: document.getElementById('assistant-approve'),
      autonomyEl: document.getElementById('assistant-autonomy'),
      cancelTaskEl: document.getElementById('assistant-cancel-task'),
      clearEl: document.getElementById('assistant-clear'),
      fileEl: document.getElementById('assistant-file'),
      fileHintEl: document.getElementById('assistant-file-hint'),
      filesEl: document.getElementById('assistant-files'),
      inputEl: document.getElementById('assistant-input'),
      loadEl: document.getElementById('assistant-load'),
      messagesEl: document.getElementById('assistant-messages'),
      modeEl: document.getElementById('assistant-mode'),
      pathEl: document.getElementById('assistant-path'),
      rejectEl: document.getElementById('assistant-reject'),
      sendEl: document.getElementById('assistant-send'),
      statusEl: document.getElementById('assistant-status'),
      suggestionsEl: document.getElementById('assistant-suggestions'),
      targetEl: document.getElementById('assistant-target'),
      tasksEl: document.getElementById('assistant-tasks'),
      writeTargetEl: document.getElementById('assistant-write-target'),
    };

    function setStatus(text) {
      if (refs.statusEl) refs.statusEl.textContent = text;
    }

    function setBusy(busy) {
      if (refs.sendEl) refs.sendEl.disabled = busy;
      if (refs.cancelTaskEl) refs.cancelTaskEl.disabled = !busy;
    }

    function setFileHint(text, isError = false) {
      if (!refs.fileHintEl) return;
      refs.fileHintEl.textContent = text;
      refs.fileHintEl.style.color = isError ? 'var(--bad)' : 'var(--muted)';
    }

    function setTargetOptions(targets) {
      if (!refs.targetEl) return;
      refs.targetEl.innerHTML = targets.map((item) => (
        `<option value="${item.value}">${item.label}</option>`
      )).join('');
    }

    function renderMessages(messages) {
      if (!refs.messagesEl) return;
      refs.messagesEl.innerHTML = '';
      messages.forEach((message) => {
        const item = document.createElement('div');
        item.className = `assistant__bubble assistant__bubble--${message.role}`;
        item.textContent = message.content;
        refs.messagesEl.appendChild(item);
      });
      refs.messagesEl.scrollTop = refs.messagesEl.scrollHeight;
    }

    function renderFiles(attachments) {
      if (!refs.filesEl) return;
      if (!attachments.length) {
        refs.filesEl.innerHTML = '<div class="assistant__file-sub">未加载文件。</div>';
        return;
      }
      refs.filesEl.innerHTML = attachments.map((item) => `
        <div class="assistant__file-item">
          <div class="assistant__file-meta">
            <div class="assistant__file-name">${item.name}</div>
            <div class="assistant__file-sub">${item.source} · ${item.sizeLabel}${item.truncated ? ' · 已截断' : ''}</div>
          </div>
          <button class="btn" data-remove-attachment="${item.id}">移除</button>
        </div>
      `).join('');
    }

    function renderSuggestions(suggestions) {
      if (!refs.suggestionsEl) return;
      if (!suggestions.length) {
        refs.suggestionsEl.innerHTML = '<div class="assistant__empty">暂时没有新的建议。</div>';
        return;
      }
      refs.suggestionsEl.innerHTML = suggestions.map((item) => `
        <div class="assistant__suggestion assistant__suggestion--${item.severity || 'info'}">
          <div class="assistant__suggestion-title">${item.title}</div>
          <div class="assistant__suggestion-body">${item.body}</div>
          ${item.action ? `<button class="btn btn--primary" data-suggestion-id="${item.id}">${item.actionLabel || '执行'}</button>` : ''}
        </div>
      `).join('');
    }

    function renderTasks(tasks) {
      if (!refs.tasksEl) return;
      if (!tasks.length) {
        refs.tasksEl.innerHTML = '<div class="assistant__empty">还没有任务记录。</div>';
        return;
      }
      refs.tasksEl.innerHTML = tasks.slice().reverse().map((task) => `
        <div class="assistant__task assistant__task--${task.status}">
          <div class="assistant__task-head">
            <div class="assistant__task-title">${task.title}</div>
            <div class="assistant__task-badge">${STATUS_LABELS[task.status] || task.status}</div>
          </div>
          <div class="assistant__task-body">${task.detail || '等待执行。'}</div>
          ${task.status === 'running' ? '<button class="btn" data-task-action="cancel">中断当前执行</button>' : ''}
        </div>
      `).join('');
    }

    function renderApproval(pendingApproval) {
      if (!refs.approvalEl || !refs.approvalTextEl) return;
      if (!pendingApproval) {
        refs.approvalEl.hidden = true;
        refs.approvalTextEl.textContent = '';
        return;
      }
      refs.approvalEl.hidden = false;
      refs.approvalTextEl.textContent = pendingApproval.text;
    }

    function bind(handlers) {
      if (refs.sendEl) {
        refs.sendEl.addEventListener('click', () => handlers.onSend?.());
      }
      if (refs.clearEl) {
        refs.clearEl.addEventListener('click', () => handlers.onClear?.());
      }
      if (refs.modeEl) {
        refs.modeEl.addEventListener('change', () => handlers.onModeChange?.(refs.modeEl.value));
      }
      if (refs.autonomyEl) {
        refs.autonomyEl.addEventListener('change', () => handlers.onAutonomyChange?.(refs.autonomyEl.value));
      }
      if (refs.inputEl) {
        refs.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handlers.onSend?.();
          }
        });
      }
      if (refs.fileEl) {
        refs.fileEl.addEventListener('change', () => {
          handlers.onUploadFiles?.(Array.from(refs.fileEl.files || []));
        });
      }
      if (refs.loadEl) {
        refs.loadEl.addEventListener('click', () => handlers.onLoadPath?.());
      }
      if (refs.writeTargetEl) {
        refs.writeTargetEl.addEventListener('click', () => handlers.onWriteTarget?.());
      }
      if (refs.approveEl) {
        refs.approveEl.addEventListener('click', () => handlers.onApprove?.());
      }
      if (refs.rejectEl) {
        refs.rejectEl.addEventListener('click', () => handlers.onReject?.());
      }
      if (refs.cancelTaskEl) {
        refs.cancelTaskEl.addEventListener('click', () => handlers.onCancelRun?.());
      }
      if (refs.filesEl) {
        refs.filesEl.addEventListener('click', (event) => {
          const button = event.target.closest('[data-remove-attachment]');
          if (!button) return;
          handlers.onRemoveAttachment?.(button.getAttribute('data-remove-attachment'));
        });
      }
      if (refs.suggestionsEl) {
        refs.suggestionsEl.addEventListener('click', (event) => {
          const button = event.target.closest('[data-suggestion-id]');
          if (!button) return;
          handlers.onSuggestionAction?.(button.getAttribute('data-suggestion-id'));
        });
      }
      if (refs.tasksEl) {
        refs.tasksEl.addEventListener('click', (event) => {
          const button = event.target.closest('[data-task-action="cancel"]');
          if (!button) return;
          handlers.onCancelRun?.();
        });
      }
    }

    function getInputValue() {
      return refs.inputEl ? refs.inputEl.value.trim() : '';
    }

    function clearInput() {
      if (refs.inputEl) refs.inputEl.value = '';
    }

    function clearFileInput() {
      if (refs.fileEl) refs.fileEl.value = '';
    }

    function getMode() {
      return refs.modeEl ? refs.modeEl.value : 'agent';
    }

    function getAutonomy() {
      return refs.autonomyEl ? refs.autonomyEl.value : 'auto_safe';
    }

    function getPathValue() {
      return refs.pathEl ? refs.pathEl.value.trim() : '';
    }

    function getTargetValue() {
      return refs.targetEl ? refs.targetEl.value.trim() : '';
    }

    return {
      bind,
      clearFileInput,
      clearInput,
      getAutonomy,
      getInputValue,
      getMode,
      getPathValue,
      getTargetValue,
      renderApproval,
      renderFiles,
      renderMessages,
      renderSuggestions,
      renderTasks,
      setBusy,
      setFileHint,
      setStatus,
      setTargetOptions,
    };
  }

  global.AssistantUI = {
    createAssistantUI,
  };
})(window);
