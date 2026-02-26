import { html, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { classMap } from 'lit/directives/class-map.js';
import { guard } from 'lit/directives/guard.js';
import { storage, initStore } from './store.js';

document.addEventListener("DOMContentLoaded", async () => {
  // --- DOM Elements ---
  const body = document.body;
  const mainContent = document.querySelector('.chat-container');
  const chatView = document.querySelector('.main-content');
  const minimizeBtn = document.getElementById('minimize-btn');
  const maximizeBtn = document.getElementById('maximize-btn');
  const closeBtn = document.getElementById('close-btn');
  const titlebarTitle = document.querySelector('.titlebar-title');
  const windowTitleInput = document.getElementById('window-title-input');
  const typingForm = document.querySelector(".typing-form");
  const typingInput = document.querySelector(".typing-input");
  const chatContainer = document.querySelector(".chat-list");
  const sidebarToggleBtn = document.querySelector("#sidebar-toggle-button");
  const settingsBtn = document.querySelector("#settings-button");
  const settingsOverlay = document.querySelector("#settings-panel-overlay");
  const sidebarHeader = document.querySelector("#sidebar-header");
  const privateModeIndicator = document.querySelector(".private-mode-indicator");
  const closeSettingsBtn = document.querySelector(".close-settings-panel");
  const sessionList = document.querySelector(".chat-session-list");
  const newSessionBtn = document.querySelector(".new-session-button");
  const stopGenerationBtn = document.querySelector("#stop-generation-btn");
  const sessionSearchInput = document.querySelector("#session-search");
  const settingsNavItems = document.querySelectorAll(".settings-nav-item");
  const settingsContents = document.querySelectorAll(".settings-content");
  const settingsTitle = document.querySelector("#settings-title");
  const welcomeTitleEl = document.getElementById("welcome-title");
  const welcomeSubtitleEl = document.getElementById("welcome-subtitle");
  const welcomeSuggestionsEl = document.getElementById("welcome-suggestions");
  const disclaimerEl = document.getElementById("disclaimer-text-element");
  // const attachFileBtn = document.getElementById('attach-file-btn');
  const fileInput = document.getElementById('file-input');
  const avatarFileInput = document.getElementById('avatar-file-input');
  const filePreviewContainer = document.getElementById('file-preview-container');
  const scanModelsBtn = document.getElementById('scan-ollama-models-btn');
  const addModelBtn = document.getElementById('add-custom-model-btn');
  const deleteModelBtn = document.getElementById('delete-selected-model-btn');
  const modelScanStatus = document.getElementById('model-scan-status');
  const lightboxOverlay = document.getElementById('lightbox-overlay');
  const lightboxImage = document.getElementById('lightbox-image');

  // --- State Variables ---
  let generatingSessionId = null;
  let currentSessionId = null;
  let settings = {};
  let sessions = {};
  let feedback = [];
  let abortController = null;
  let attachedFiles = [];
  // Performance Optimization: Animation Frame ID for streaming
  let streamAnimationFrameId = null;
  // Performance Optimization: Resize Frame ID
  let resizeAnimationFrameId = null;
  // Private Mode
  let isPrivateMode = false;
  let editingIndex = null;
  let streamChunkListener = null;
  let streamErrorListener = null;
  let currentStreamId = null;
  let promptLibrary = [];
  let lightboxScale = 1;

  // --- Smart Auto Scroll State ---
  let isAutoScrollEnabled = true;
  const SCROLL_THRESHOLD = 5;

  // --- Streaming Markdown State Management ---
  const streamingRenderers = new Map();
  const lastContentLength = new Map();
  const messageBuffers = new Map();

  let cssEditor = null;

  // --- ID Generator ---
  const generateMessageId = (() => {
    let counter = 0;
    return () => {
      const timestamp = Date.now();
      return `${timestamp}_${++counter}`;
    };
  })();

  // --- Utility Functions ---
  /**
   * Formats a number for display, rounding to 2 decimal places 
   * and removing unnecessary trailing zeros.
   */
  const formatNumericDisplay = (val) => {
    return Number(Math.round(parseFloat(val) * 100) / 100);
  };

  /**
   * Synchronizes temperature state across UI elements and settings object.
   * @param {number|string} value - The new temperature value
   * @param {boolean} shouldSave - Whether to trigger persistence
   */
  const syncTemperature = async (value, shouldSave = false) => {
    const parsed = parseFloat(value);
    if (isNaN(parsed)) return;

    const clamped = Math.min(1, Math.max(0, parsed));
    const finalValue = Math.round(clamped * 100) / 100;
    
    // Update DOM elements
    const slider = document.getElementById("temperature");
    const display = document.getElementById("temperature-value");
    
    if (slider) slider.value = finalValue;
    if (display) display.textContent = formatNumericDisplay(finalValue);
    
    // Update internal state
    settings.temperature = finalValue;
    
    if (shouldSave) {
      await saveSettings();
    }
  };

  // --- CSS Editor Initialization ---
  const initCSSEditor = () => {
    const container = document.getElementById('custom-css-input-container');
    if (!container) {
      console.warn('CSS editor container not found');
      return;
    }

    if (!window.CSSEditor || !window.CSSEditor.basicEditor) {
      if (!window.cssEditorRetryCount) window.cssEditorRetryCount = 0;
      window.cssEditorRetryCount++;
      if (window.cssEditorRetryCount < 50) {
        console.warn(`CSSEditor not loaded. Retrying in 100ms... (${window.cssEditorRetryCount}/50)`);
        setTimeout(initCSSEditor, 100);
        return;
      } else {
        console.error('CSSEditor failed to load after 50 retries');
        return;
      }
    }

    const isDarkMode = !body.classList.contains('light-mode');
    const theme = isDarkMode ? 'github-dark' : 'github-light';

    try {
      cssEditor = window.CSSEditor.basicEditor('#custom-css-input-container', {
        language: 'css',
        theme: theme,
        wordWrap: true,
        value: settings.customCSS || '',
        placeholder: '',
        onUpdate: debounceSyncSettings
      });
    } catch (error) {
      console.error('Failed to initialize CSS editor:', error);
    }
  };

  // --- Initialization ---
  const initializeSidebarState = () => {
    const isClosed = body.classList.contains("sidebar-closed");
    sidebarToggleBtn.classList.toggle("active", !isClosed);
    sidebarToggleBtn.setAttribute("aria-expanded", String(!isClosed));
  };

const initialize = async () => {
    // 0. Initialize store and migrate data if needed
    await initStore();
    
    // 1. Data Loading (Load all persistent data first)
    await loadSettings();
    await loadPromptLibrary();
    await loadFeedback();
    await loadSessions();

    // 2. Configuration & State Initialization
    configureMarked();
    populateFontDropdown(); // Initialize system fonts
    await populateSettingsForm(); // Populates form elements and calls applyTheme()
    applyUISettings();     // Applies UI settings and calls renderChat(), applyCustomCSS(), updateWindowTitle()
    applySidebarWidth();
    initializeSidebarState();

    // 3. Session Initial Display (Depends on loaded sessions)
    if (!currentSessionId || !sessions[currentSessionId]) {
      createNewSession(); // Creates session and handles its rendering via switchSession()
    } else {
      renderSessionList();
      // renderChat() is already called by applyUISettings() above
    }

    // 4. Interaction & Event Setup
    addEventListeners();
    updateInputState();
    resizeTextarea();
    initSidebarResize();

    // 5. Component Initialization (Depends on DOM and settings)
    initCSSEditor();

    // 6. Background Services (Non-blocking)
    if (settings.enableNetworkService && window.__TAURI__) {
      window.__TAURI__.core.invoke('manage_proxy_server', { enable: true, port: settings.proxyPort })
          .catch(err => console.error("Failed to start proxy service on init:", err));
    }
  };

  // --- Configuration ---

  const configureMarked = () => {
    marked.setOptions({
      highlight: function(code, lang) {
        if (settings.syntaxHighlighting && window.hljs) {
          const language = hljs.getLanguage(lang) ? lang : 'plaintext';
          try {
            return hljs.highlight(code, {
              language,
              ignoreIllegals: true
            }).value;
          } catch (e) {
            return code;
          }
        }
        return code.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      },
      gfm: true,
      breaks: true
    });
  };

  const addEventListeners = () => {
    if (minimizeBtn) {
      minimizeBtn.addEventListener("click", async () => {
        if (window.__TAURI__) {
          const appWindow = window.__TAURI__.window.getCurrentWindow();
          await appWindow.minimize();
        }
      });
    }
    if (maximizeBtn) {
      maximizeBtn.addEventListener("click", async () => {
        if (window.__TAURI__) {
          const appWindow = window.__TAURI__.window.getCurrentWindow();
          await appWindow.toggleMaximize();
        }
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", async () => {
        if (window.__TAURI__) {
          const appWindow = window.__TAURI__.window.getCurrentWindow();
          await appWindow.close();
        }
      });
    }
    if (titlebarTitle) {
      let lastClickTime = 0;
      titlebarTitle.addEventListener("mousedown", async (e) => {
        if (window.__TAURI__) {
          const appWindow = window.__TAURI__.window.getCurrentWindow();
          const currentTime = new Date().getTime();
          if (currentTime - lastClickTime < 300) {
            await appWindow.toggleMaximize();
            lastClickTime = 0;
          } else {
            await appWindow.startDragging();
            lastClickTime = currentTime;
          }
        }
      });
    }
    if (window.__TAURI__) {
      const appWindow = window.__TAURI__.window.getCurrentWindow();
      const checkFullscreen = async () => {
        const isFullscreen = await appWindow.isFullscreen();
        document.querySelector('.titlebar').style.display = isFullscreen ? 'none' : 'flex';
      };
      window.__TAURI__.event.listen('tauri://resize', checkFullscreen);
      checkFullscreen();
    }
    sidebarToggleBtn.addEventListener("click", toggleSidebar);
    sidebarToggleBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleSidebar();
      }
    });
    newSessionBtn.addEventListener("click", createNewSession);
    typingForm.addEventListener("submit", (e) => handleSendMessage(e, {}));
    typingInput.addEventListener("input", resizeTextarea);
    typingInput.addEventListener("keydown", handleEnterKey);
    settingsBtn.addEventListener("click", openSettingsPanel);
    closeSettingsBtn.addEventListener("click", closeSettingsPanel);
    settingsOverlay.addEventListener("click", (e) => {
      if (e.target === settingsOverlay) closeSettingsPanel();
    });
    document.getElementById("settings-form").addEventListener("input", debounceSyncSettings);
    document.getElementById("settings-form").addEventListener("change", debounceSyncSettings);

    stopGenerationBtn.addEventListener("click", stopGeneration);
    sessionSearchInput.addEventListener("input", renderSessionList);
    fileInput.addEventListener('change', handleFileSelect);
    avatarFileInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      const role = avatarFileInput.dataset.role;
      if (file && role) {
        handleAvatarUpload(file, role);
      }
      avatarFileInput.value = '';
    });
    typingInput.addEventListener('paste', handlePaste);

    lightboxOverlay?.addEventListener('click', closeLightbox);

    addEventListenersForDragDrop();

    document.addEventListener('keydown', (e) => {
      if (e.key === "Escape") {
        if (body.classList.contains("settings-open")) {
          closeSettingsPanel();
        }
        if (lightboxOverlay?.classList.contains('show')) {
          closeLightbox();
        }
        const dropdown = document.getElementById('session-action-dropdown');
        if (dropdown) {
          dropdown.classList.remove('show');
          sessionList.classList.remove('scroll-locked');
        }
      }
    });

    // Add wheel zoom for lightbox
    lightboxOverlay?.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      lightboxScale = Math.max(0.1, Math.min(10, lightboxScale + delta));
      lightboxImage.style.transform = `scale(${lightboxScale})`;
    }, { passive: false });

    document.addEventListener('contextmenu', (event) => {
      const target = event.target;
      const isTitlebar = target.closest('.titlebar');
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('pre');
      const composedPath = event.composedPath ? event.composedPath() : [];
      const isCSSEditor = target.closest('#custom-css-input-container') ||
          composedPath.some(el => el.id === 'custom-css-input-container');
      if (!isInput && !isTitlebar && !isCSSEditor) {
        event.preventDefault();
      }
    });

    settingsNavItems.forEach(item => {
      item.addEventListener("click", () => {
        const section = item.dataset.section;
        settingsNavItems.forEach(i => i.classList.remove("active"));
        settingsContents.forEach(c => c.classList.remove("active"));
        item.classList.add("active");
        const contentEl = document.getElementById(`${section}-settings`);
        contentEl.classList.add("active");
        settingsTitle.textContent = item.querySelector("span:last-child").textContent;

        if (section === 'feedback') {
          renderFeedbackTab();
        }
        if (section === 'prompts') {
          renderPromptLibrary();
        }
      });
    });

    document.querySelectorAll(".theme-toggle-switch button").forEach(button => {
      button.addEventListener("click", async () => {
        settings.theme = button.dataset.theme;
        applyTheme();
        document.querySelectorAll(".theme-toggle-switch button").forEach(b => {
          b.classList.toggle("active", b.dataset.theme === settings.theme);
        });
        await saveSettings();
      });
    });

    // Listen for system theme changes when in system-mode
    const systemThemeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    systemThemeMediaQuery.addEventListener("change", () => {
      if (settings.theme === "system-mode") {
        applyTheme();
      }
    });

    document.getElementById("temperature").addEventListener("input", async e => {
      await syncTemperature(e.target.value);
    });

    document.getElementById("temperature-value").addEventListener("click", () => {
      const currentVal = document.getElementById("temperature").value;
      showPrompt("设置模型温度", currentVal, async (newVal) => {
        if (newVal !== null && newVal.trim() !== "") {
          const parsed = parseFloat(newVal);
          if (!isNaN(parsed)) {
            await syncTemperature(parsed, true);
          } else {
            showToast("请输入有效的数字", "error");
          }
        }
      });
    });

document.getElementById("export-settings-btn").addEventListener("click", exportSettings);
    document.getElementById("import-settings-btn").addEventListener("click", importSettings);
    document.getElementById("reset-settings-btn").addEventListener("click", resetAllSettings);
    document.getElementById("export-all-chats-btn").addEventListener("click", exportAllChats);
    document.getElementById("import-all-chats-btn").addEventListener("click", importAllChats);
    document.getElementById("clear-all-chats-btn").addEventListener("click", clearAllChats);

    document.getElementById("add-new-prompt-btn")?.addEventListener("click", addNewPrompt);

    privateModeIndicator.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePrivateMode();
    });

    sidebarHeader.addEventListener("click", () => togglePrivateMode());

    scanModelsBtn.addEventListener('click', scanOllamaModels);
    addModelBtn.addEventListener('click', addCustomModel);
    deleteModelBtn.addEventListener('click', deleteSelectedModel);

    const devToolsBtn = document.getElementById('open-devtools-btn');
    if (devToolsBtn) {
      devToolsBtn.addEventListener('click', async () => {
        if (window.__TAURI__) {
          try {
            await window.__TAURI__.core.invoke('open_devtools');
          } catch (error) {
            console.error('Failed to open DevTools:', error);
            showToast('Failed to open DevTools', 'error');
          }
        } else {
          console.warn('Tauri API not available');
          showToast('Tauri API not available', 'error');
        }
      });
    }

    chatView.addEventListener("scroll", () => {
      const distanceToBottom = chatView.scrollHeight - chatView.scrollTop - chatView.clientHeight;

      if (distanceToBottom < SCROLL_THRESHOLD) {
        if (!isAutoScrollEnabled) isAutoScrollEnabled = true;
      } else {
        if (isAutoScrollEnabled) isAutoScrollEnabled = false;
      }
    });
  };

  // --- Model Management ---
  const populateModelDropdown = () => {
    const modelSelect = document.getElementById('model');
    const allModels = settings.customModels || [];

    modelSelect.innerHTML = '';

    if (allModels.length === 0) {
      modelSelect.innerHTML = '<option value="">Please scan or add the model first.</option>';
    } else {
      allModels.forEach(modelName => {
        const option = document.createElement('option');
        option.value = modelName;
        option.textContent = modelName;
        modelSelect.appendChild(option);
      });
    }

    if (settings.model && allModels.includes(settings.model)) {
      modelSelect.value = settings.model;
    } else if (allModels.length > 0) {
      modelSelect.value = allModels[0];
      settings.model = allModels[0];
    } else {
      settings.model = "";
    }
  };

    const populateFontDropdown = async () => {
        const fontSelect = document.getElementById('custom-font');
        if (!fontSelect) return;

        // Save current selection to restore it after repopulating
        const currentSelection = settings.customFont || 'default';

        // Clear existing options except default
        fontSelect.innerHTML = '<option value="default">Default Font</option>';

        try {
            // First check if the Tauri plugin is available
            if (window.__TAURI__ && window.__TAURI__.invoke) {
                try {
                    // Try to use the low-level tauri-plugin-system-fonts API
                    // Note: We're using the direct invoke since we don't know the exact import path in the bundled app
                    // The plugin's default command is "plugin:system-fonts|get_system_fonts"
                    const fonts = await window.__TAURI__.invoke("plugin:system-fonts|get_system_fonts");

                    if (fonts && Array.isArray(fonts)) {
                        // De-duplicate font families (plugin returns family, path, etc)
                        const families = [...new Set(fonts.map(f => f.family))].sort();

                        families.forEach(family => {
                            const option = document.createElement('option');
                            option.value = family;
                            option.textContent = family;
                            fontSelect.appendChild(option);
                        });

                        console.log(`Loaded ${families.length} system fonts via Tauri plugin.`);
                        restoreSelection(fontSelect, currentSelection);
                        return;
                    }
                } catch (e) {
                    console.warn("Tauri system-fonts plugin failed, falling back to browser API:", e);
                }
            }

            // Fallback 1: Modern Browser API: queryLocalFonts
            if (window.queryLocalFonts) {
                try {
                    const fonts = await window.queryLocalFonts();
                    const families = [...new Set(fonts.map(f => f.family))].sort();

                    families.forEach(family => {
                        const option = document.createElement('option');
                        option.value = family;
                        option.textContent = family;
                        fontSelect.appendChild(option);
                    });

                    console.log(`Loaded ${families.length} system fonts via browser API.`);
                } catch (e) {
                    console.warn("Local font access denied or failed:", e);
                    addFallbackFonts(fontSelect);
                }
            } else {
                addFallbackFonts(fontSelect);
            }
        } catch (error) {
            console.error("Font population error:", error);
            addFallbackFonts(fontSelect);
        }

        restoreSelection(fontSelect, currentSelection);
    };

    const restoreSelection = (fontSelect, currentSelection) => {
        // Restore selection
        fontSelect.value = currentSelection;
        // If restoration failed (font no longer available), fallback to default
        if (fontSelect.selectedIndex === -1) {
            fontSelect.value = 'default';
            settings.customFont = 'default';
        }
    };

  const addFallbackFonts = (selectEl) => {
    // Curated list of high-quality fonts for different platforms
    const commonFonts = [
      // Windows
      "Segoe UI", "Microsoft YaHei", "Consolas", "Verdana", "Arial",
      // macOS
      "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", "Menlo", "Monaco",
      // Linux
      "Ubuntu", "Roboto", "Noto Sans SC", "Liberation Sans",
      // General
      "Georgia", "Times New Roman", "Courier New"
    ];

    const uniqueFonts = [...new Set(commonFonts)].sort();
    
    uniqueFonts.forEach(font => {
      const option = document.createElement('option');
      option.value = font;
      option.textContent = font;
      selectEl.appendChild(option);
    });
  };

  const applyFont = () => {
    const font = settings.customFont || 'default';
    if (font === 'default') {
      document.documentElement.style.setProperty('--interface-font', 'Inter, sans-serif');
    } else {
      // Use the chosen font with a generic fallback
      document.documentElement.style.setProperty('--interface-font', `"${font}", Inter, sans-serif`);
    }
  };

  const scanOllamaModels = async () => {
    const apiEndpoint = document.getElementById('api-endpoint').value.trim();
    if (!apiEndpoint) {
      showToast("请先设置API端点", "error");
      return;
    }

    modelScanStatus.textContent = '正在扫描';
    try {
      const modelNames = await window.__TAURI__.core.invoke('scan_ollama_models', {
        apiEndpoint,
        apiKey: settings.apiKey || null
      });

      if (!Array.isArray(modelNames)) {
        throw new Error(`从API返回的格式无效`);
      }

      const currentModels = new Set(settings.customModels || []);
      modelNames.forEach(name => currentModels.add(name));
      settings.customModels = Array.from(currentModels).sort();

      await saveSettings();
      populateModelDropdown();

      if (!settings.model && settings.customModels.length > 0) {
        document.getElementById('model').value = settings.customModels[0];
      }

      modelScanStatus.textContent = `扫描完成！找到 ${modelNames.length} 个新模型`;
      showToast("本地模型扫描成功", "success");
    } catch (error) {
      console.error("Error scanning Ollama models:", error);
      modelScanStatus.textContent = '扫描失败';
      showToast(`扫描失败`, "error");
    }
  };

  const addCustomModel = () => {
    showPrompt("输入自定义模型名称", "", async (newModel) => {
      if (newModel && newModel.trim() !== "") {
        const modelName = newModel.trim();
        if (!settings.customModels) {
          settings.customModels = [];
        }
        if (settings.customModels.includes(modelName)) {
          showToast("该模型已存在", "info");
          return;
        }
        settings.customModels.push(modelName);
        settings.customModels.sort();
        await saveSettings();
        populateModelDropdown();
        document.getElementById('model').value = modelName;
        showToast(`模型 "${modelName}" 已添加`, "success");
      }
    });
  };

  const deleteSelectedModel = () => {
    const modelSelect = document.getElementById('model');
    const modelToDelete = modelSelect.value;

    if (!modelToDelete || settings.customModels.length === 0) {
      showToast("没有可删除的模型", "error");
      return;
    }

    showConfirm(`确认删除模型 "${modelToDelete}"`, "此操作无法撤销", async () => {
      const index = settings.customModels.indexOf(modelToDelete);
      if (index > -1) {
        settings.customModels.splice(index, 1);
        await saveSettings();
        populateModelDropdown();
        showToast(`模型 "${modelToDelete}" 已删除`, "success");
      } else {
        showToast("找不到要删除的模型", "error");
      }
    });
  };

  // --- Prompt Library Management ---
  const loadPromptLibrary = async () => {
    promptLibrary = (await storage.getItem("ai-assistant-prompts")) || [];

    // Migration Logic: If library is empty but we have a system prompt in settings,
    // create a default prompt from it.
    if (promptLibrary.length === 0 && settings.systemPrompt && settings.systemPrompt.trim() !== "") {
      const defaultPrompt = {
        id: Date.now().toString(),
        name: "Default System Prompt",
        content: settings.systemPrompt,
        active: true
      };
        promptLibrary.push(defaultPrompt);
        await savePromptLibrary();
      }

    // Check if settings.systemPrompt matches any existing prompt content and sync active state
    if (promptLibrary.length > 0) {
      // If settings has a system prompt, try to find it and mark active.
      // If settings is empty, we don't force anything to be active.
      if (settings.systemPrompt) {
        const match = promptLibrary.find(p => p.content === settings.systemPrompt);
        if (match) {
          promptLibrary.forEach(p => p.active = false);
          match.active = true;
        }
      } else {
        // If settings.systemPrompt is empty, ensure no prompt is marked active
        promptLibrary.forEach(p => p.active = false);
      }
      await savePromptLibrary();
    }
  };

  const savePromptLibrary = async () => {
    await storage.setItem("ai-assistant-prompts", promptLibrary);
    // Sync active prompt to settings.systemPrompt
    const activePrompt = promptLibrary.find(p => p.active);
    settings.systemPrompt = activePrompt ? activePrompt.content : "";
    await saveSettings(); // Persist the change to settings as well
  };

  const renderPromptLibrary = () => {
    const listContainer = document.getElementById("prompt-library-list");
    if (!listContainer) return;

    listContainer.innerHTML = "";
    if (promptLibrary.length === 0) {
      listContainer.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--subheading-color); padding: 2rem;">No system prompts defined. Add one to get started.</p>';
      return;
    }

    promptLibrary.forEach((prompt, index) => {
      const item = document.createElement("div");
      item.className = `prompt-card ${prompt.active ? 'active' : ''}`;

      // Logic for button text/icon based on active state
      let activateBtnContent = 'Activate';
      let activateBtnTitle = 'Set as system prompt';

      if (prompt.active) {
        activateBtnContent = '<span class="material-symbols-rounded" style="font-size:16px">check</span> Active';
        activateBtnTitle = 'Click to disable system prompt';
      }

      item.innerHTML = `
        <div class="prompt-card-header">
          <span class="prompt-card-title">${DOMPurify.sanitize(prompt.name)}</span>
          <span class="prompt-card-badge">Active</span>
        </div>
        <div class="prompt-card-content">${DOMPurify.sanitize(prompt.content)}</div>
        <div class="prompt-card-footer">
          <button type="button" class="prompt-card-action-btn activate" title="${activateBtnTitle}">
            ${activateBtnContent}
          </button>
          <button type="button" class="prompt-card-action-btn edit" title="Edit">
            <span class="material-symbols-rounded">edit</span>
          </button>
          <button type="button" class="prompt-card-action-btn delete" title="Delete">
            <span class="material-symbols-rounded">delete</span>
          </button>
        </div>
      `;

      item.querySelector(".edit").onclick = () => editPrompt(index);
      item.querySelector(".delete").onclick = () => deletePrompt(index);
      item.querySelector(".activate").onclick = () => activatePrompt(index);

      // Add hover effect for the active button via JS to change text to "Disable"
      if (prompt.active) {
        const btn = item.querySelector(".activate");
        btn.onmouseenter = () => {
          btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px">block</span> Disable';
        };
        btn.onmouseleave = () => {
          btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px">check</span> Active';
        };
      }

      listContainer.appendChild(item);
    });
  };

  const activatePrompt = async (index) => {
    const targetPrompt = promptLibrary[index];

    if (targetPrompt.active) {
      // Deactivate if already active (Toggle off)
      targetPrompt.active = false;
      showToast("System prompt disabled", "info");
    } else {
      // Activate this one, deactivate others
      promptLibrary.forEach((p, i) => {
        p.active = (i === index);
      });
      showToast("System prompt activated", "success");
    }

    await savePromptLibrary();
    renderPromptLibrary();
  };

  const addNewPrompt = () => {
    showPromptEditor("New System Prompt", "", "", async (result) => {
      if (!result) return;

      const isActive = false;

      promptLibrary.push({
        id: Date.now().toString(),
        name: result.name,
        content: result.content,
        active: isActive
      });
      await savePromptLibrary();
      renderPromptLibrary();
      showToast("System prompt created", "success");
    });
  };

  const editPrompt = (index) => {
    const prompt = promptLibrary[index];
    showPromptEditor("Edit System Prompt", prompt.name, prompt.content, async (result) => {
      if (!result) return;

      promptLibrary[index] = {
        ...prompt,
        name: result.name,
        content: result.content
      };
      await savePromptLibrary();
      renderPromptLibrary();
      showToast("System prompt updated", "success");
    });
  };

  const deletePrompt = (index) => {
    showConfirm("Delete Prompt", "Are you sure you want to remove this system prompt?", async () => {
      const wasActive = promptLibrary[index].active;
      promptLibrary.splice(index, 1);

      // If we deleted the active prompt, warn user or clear system prompt
      if (wasActive) {
        settings.systemPrompt = "";
        showToast("Active system prompt deleted. No system prompt is currently set.", "info");
      } else {
        showToast("Prompt deleted", "info");
      }

      await savePromptLibrary();
      renderPromptLibrary();
    });
  };

  // --- Feedback Management ---
  const loadFeedback = async () => {
    feedback = (await storage.getItem("ai-assistant-feedback")) || [];
  };

  const saveFeedback = async () => {
    await storage.setItem("ai-assistant-feedback", feedback);
  };

  const handleFeedback = async (e) => {
    const button = e.currentTarget;
    const feedbackType = button.dataset.feedbackType;
    const messageIndex = parseInt(button.dataset.messageIndex, 10);
    const session = sessions[currentSessionId];
    const message = session?.history[messageIndex];

    if (message) {
      if (message.feedbackSubmitted) {
        showToast("您已经提交过反馈了", "info");
        return;
      }

      feedback.push({
        sessionId: currentSessionId,
        messageIndex: messageIndex,
        messageContent: message.content,
        feedbackType: feedbackType,
        timestamp: Date.now()
      });
      await saveFeedback();

      message.feedbackSubmitted = feedbackType;
      await saveSessions();

      showToast("感谢您的反馈", "success");
      renderChat();
    }
  };

  const deleteSingleFeedback = async (timestamp) => {
    const index = feedback.findIndex(item => item.timestamp === timestamp);
    if (index > -1) {
      const deletedFeedback = feedback[index];
      feedback.splice(index, 1);
      await saveFeedback();

      const session = sessions[deletedFeedback.sessionId];
      if (session && session.history[deletedFeedback.messageIndex]) {
        delete session.history[deletedFeedback.messageIndex].feedbackSubmitted;
        await saveSessions();
      }

      renderFeedbackTab();
      renderChat();
      showToast('反馈已删除', 'success');
    }
  };

  const renderFeedbackTab = () => {
    const container = document.getElementById('feedback-settings');
    container.innerHTML = '';

    if (!feedback || feedback.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--subheading-color); padding: 2rem 0;">No feedback records at this time.</p>';
      return;
    }

    const feedbackList = document.createElement('ul');
    feedbackList.className = 'feedback-list';

    feedback.slice().reverse().forEach(item => {
      const li = document.createElement('li');
      li.className = 'feedback-item';
      const icon = item.feedbackType === 'like' ? 'thumb_up' : 'thumb_down';
      const color = item.feedbackType === 'like' ? 'var(--success-color)' : 'var(--error-color)';
      li.innerHTML = `
        <div class="feedback-item-header">
            <span class="material-symbols-rounded" style="color: ${color};">${icon}</span>
            <span class="feedback-timestamp">${new Date(item.timestamp).toLocaleString()}</span>
        </div>
        <p class="feedback-message-content">${DOMPurify.sanitize(item.messageContent)}</p>
        <div class="feedback-item-actions">
          <button class="feedback-action-btn copy-feedback-btn" title="复制内容">
            <span class="material-symbols-rounded">content_copy</span>
          </button>
          <button class="feedback-action-btn delete-feedback-btn" title="删除反馈">
            <span class="material-symbols-rounded">delete</span>
          </button>
        </div>
      `;

      const copyBtn = li.querySelector('.copy-feedback-btn');
      const deleteBtn = li.querySelector('.delete-feedback-btn');

      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(item.messageContent).then(() => {
          showToast('内容已复制到剪贴板', 'success');
        }).catch(() => {
          showToast('复制失败', 'error');
        });
      });

      deleteBtn.addEventListener('click', () => {
        showConfirm('确认删除此反馈', '此操作无法撤销', () => {
          deleteSingleFeedback(item.timestamp);
        });
      });

      feedbackList.appendChild(li);
    });

    const clearFeedbackBtn = document.createElement('button');
    clearFeedbackBtn.id = 'clear-all-feedback-btn';
    clearFeedbackBtn.textContent = 'Delete All Feedback';
    clearFeedbackBtn.className = 'glass-button error-button';

    clearFeedbackBtn.addEventListener('click', () => {
      showConfirm('确认清除所有反馈', '此操作无法撤销', async () => {
        feedback = [];
        await saveFeedback();
        Object.values(sessions).forEach(session => {
          session.history.forEach(message => {
            if (message.feedbackSubmitted) {
              delete message.feedbackSubmitted;
            }
          });
        });
        await saveSessions();
        renderFeedbackTab();
        renderChat();
        showToast('所有反馈已清除', 'success');
      });
    });

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'feedback-button-container';
    buttonContainer.appendChild(clearFeedbackBtn);

    container.appendChild(feedbackList);
    container.appendChild(buttonContainer);
  };

  // --- Settings Management ---
  const loadSettings = async () => {
    const savedSettings = (await storage.getItem("ai-assistant-settings")) || {};
    settings = {
      theme: savedSettings.theme || "system-mode",
      settingsWindowed: savedSettings.settingsWindowed === true,
      apiKey: savedSettings.apiKey !== undefined ? savedSettings.apiKey : "",
      apiEndpoint: savedSettings.apiEndpoint !== undefined ? savedSettings.apiEndpoint : "http://localhost:11434/api/chat",
      model: savedSettings.model || "",
      customModels: savedSettings.customModels || [],
      maxContextLength: savedSettings.maxContextLength || 20,
      systemPrompt: savedSettings.systemPrompt !== undefined ? savedSettings.systemPrompt : "",
      temperature: savedSettings.temperature !== undefined ? savedSettings.temperature : 0.8,
      displayMarkdown: savedSettings.displayMarkdown !== false,
      showDialogueInfo: savedSettings.showDialogueInfo === true,
      enableStreaming: savedSettings.enableStreaming !== false,
      showThinkingProcess: savedSettings.showThinkingProcess !== false,
      autoRunMode: savedSettings.autoRunMode || (savedSettings.autoRunCode === true ? 'sandbox' : 'none'),
      autoRunFormats: savedSettings.autoRunFormats || "html",
      allowTauriApi: savedSettings.allowTauriApi === true,
      syntaxHighlighting: savedSettings.syntaxHighlighting !== false,
      fontSize: savedSettings.fontSize || "medium",
      compactMode: savedSettings.compactMode === true,
      showTimestamps: savedSettings.showTimestamps === true,
      showAvatars: savedSettings.showAvatars === true,
      enableAnimations: savedSettings.enableAnimations !== false,
      showActionBtns: savedSettings.showActionBtns !== false,
      welcomeTitle: savedSettings.welcomeTitle !== undefined ? savedSettings.welcomeTitle : "",
      welcomeSubtitle: savedSettings.welcomeSubtitle !== undefined ? savedSettings.welcomeSubtitle : "",
      welcomeSuggestions: savedSettings.welcomeSuggestions !== undefined ? savedSettings.welcomeSuggestions : "",
      showWelcomeScreen: savedSettings.showWelcomeScreen === true,
      showDisclaimer: savedSettings.showDisclaimer === true,
      disclaimerText: savedSettings.disclaimerText !== undefined ? savedSettings.disclaimerText : "Miscuay may display inaccurate info, so double-check its responses.",
      customCSS: savedSettings.customCSS || "",
      windowTitle: savedSettings.windowTitle !== undefined ? savedSettings.windowTitle : "",
      enableNetworkService: savedSettings.enableNetworkService === true,
      proxyPort: savedSettings.proxyPort || 8080,
      sidebarWidth: savedSettings.sidebarWidth || 260,
      enableAutoSummary: savedSettings.enableAutoSummary !== false,
      summaryPrompt: savedSettings.summaryPrompt || "Based on the above dialogue content, summarize a concise dialogue title in the same language as the content, not exceeding 10 characters. Return the title text directly without including quotation marks, explanations, or punctuation.",
      autoContinueStream: savedSettings.autoContinueStream === true,
      userAvatar: savedSettings.userAvatar || "",
      assistantAvatar: savedSettings.assistantAvatar || "",
      customFont: savedSettings.customFont || "default",
      showScrollbar: savedSettings.showScrollbar === true
    };
  };

  const saveSettings = async () => {
    await storage.setItem("ai-assistant-settings", settings);
  };

  let syncTimeout = null;
  const debounceSyncSettings = () => {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(syncAndSaveSettings);
  };

  const syncAndSaveSettings = async () => {
    const oldEnableNetworkService = settings.enableNetworkService;
    const oldProxyPort = settings.proxyPort;

    // Data Management & Connection
    settings.apiKey = document.getElementById("api-key").value.trim();
    settings.apiEndpoint = document.getElementById("api-endpoint").value.trim();
    settings.model = document.getElementById("model").value;
    settings.maxContextLength = Math.min(100, Math.max(1, parseInt(document.getElementById("max-context-length").value) || 20));

    // Behavior
    settings.temperature = parseFloat(document.getElementById("temperature").value);
    settings.displayMarkdown = document.getElementById("display-markdown").checked;
    settings.settingsWindowed = document.getElementById("settings-windowed-mode").checked;
    settings.showDialogueInfo = document.getElementById("show-dialogue-info").checked;
    settings.enableStreaming = document.getElementById("enable-streaming").checked;
    settings.showThinkingProcess = document.getElementById("show-thinking-process").checked;
    // settings.autoRunMode = document.getElementById("auto-run-mode").value;
    // settings.autoRunFormats = document.getElementById("auto-run-formats").value.trim();
    // settings.allowTauriApi = document.getElementById("allow-tauri-api").checked;
    settings.enableAutoSummary = document.getElementById("enable-auto-summary").checked;
    // settings.autoContinueStream = document.getElementById("auto-continue-stream").checked;

    // Appearance
    settings.syntaxHighlighting = document.getElementById("syntax-highlighting").checked;
    settings.customFont = document.getElementById("custom-font").value;
    // settings.fontSize = document.getElementById("font-size").value;
    settings.compactMode = document.getElementById("compact-mode").checked;
    settings.showTimestamps = document.getElementById("show-timestamps").checked;
    settings.showAvatars = document.getElementById("show-avatars").checked;
    settings.enableAnimations = document.getElementById("enable-animations").checked;
    settings.showActionBtns = document.getElementById("show-action-btns").checked;
    settings.showScrollbar = document.getElementById("show-scrollbar").checked;

    // Customization
    settings.windowTitle = document.getElementById("window-title-input").value.trim();
    settings.showWelcomeScreen = document.getElementById("show-welcome-screen").checked;
    settings.welcomeTitle = document.getElementById("welcome-title-input").value.trim();
    settings.welcomeSubtitle = document.getElementById("welcome-subtitle-input").value.trim();
    settings.welcomeSuggestions = document.getElementById("welcome-suggestions-input").value.trim();
    settings.summaryPrompt = document.getElementById("summary-prompt-input").value.trim();
    settings.showDisclaimer = document.getElementById("show-disclaimer").checked;
    settings.disclaimerText = document.getElementById("custom-disclaimer-input").value.trim();
    if (cssEditor) settings.customCSS = cssEditor.value;
    settings.enableNetworkService = document.getElementById("enable-network-service").checked;

    settings.proxyPort = parseInt(document.getElementById("proxy-port").value) || 8080;

    await saveSettings();
    configureMarked();
    applyUISettings();
    applyFont();

    if (settings.enableNetworkService !== oldEnableNetworkService || settings.proxyPort !== oldProxyPort) {
      if (window.__TAURI__) {
        try {
          await window.__TAURI__.core.invoke('manage_proxy_server', {
            enable: settings.enableNetworkService,
            port: settings.proxyPort
          });
        } catch (error) {
          console.error("Failed to toggle proxy service:", error);
        }
      }
    }
  };

  const applyTheme = () => {
    if (settings.theme === "system-mode") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      body.classList.toggle("light-mode", !prefersDark);
    } else {
      body.classList.toggle("light-mode", settings.theme === "light-mode");
    }
    document.querySelectorAll(".theme-toggle-switch button").forEach(button => {
      button.classList.toggle("active", button.dataset.theme === settings.theme);
    });

    // Sync CSS editor theme with current mode
    updateCSSEditorTheme();
  };

  const updateCSSEditorTheme = () => {
    if (!cssEditor) return;

    const isDarkMode = !body.classList.contains('light-mode');
    const newTheme = isDarkMode ? 'github-dark' : 'github-light';

    // Use setOptions to change theme (prism-code-editor API)
    if (typeof cssEditor.setOptions === 'function') {
      cssEditor.setOptions({ theme: newTheme });
    }
  };

  const populateSettingsForm = async () => {
    document.getElementById("api-key").value = settings.apiKey;
    document.getElementById("api-endpoint").value = settings.apiEndpoint;

    populateModelDropdown();

    document.getElementById("max-context-length").value = settings.maxContextLength;
    // System Prompt input removed in favor of Prompt Library
    // document.getElementById("system-prompt").value = settings.systemPrompt;
    await syncTemperature(settings.temperature);
    document.getElementById("display-markdown").checked = settings.displayMarkdown;
    document.getElementById("settings-windowed-mode").checked = settings.settingsWindowed;
    document.getElementById("show-dialogue-info").checked = settings.showDialogueInfo;
    document.getElementById("enable-streaming").checked = settings.enableStreaming;
    document.getElementById("show-thinking-process").checked = settings.showThinkingProcess;
    // document.getElementById("auto-run-mode").value = settings.autoRunMode || 'none';
    // document.getElementById("auto-run-formats").value = settings.autoRunFormats || 'html';
    // document.getElementById("allow-tauri-api").checked = settings.allowTauriApi;
    document.getElementById("syntax-highlighting").checked = settings.syntaxHighlighting;
    document.getElementById("custom-font").value = settings.customFont || "default";
    // document.getElementById("font-size").value = settings.fontSize;
    document.getElementById("compact-mode").checked = settings.compactMode;
    document.getElementById("show-timestamps").checked = settings.showTimestamps;
    document.getElementById("show-avatars").checked = settings.showAvatars;
    document.getElementById("enable-animations").checked = settings.enableAnimations;
    document.getElementById("show-action-btns").checked = settings.showActionBtns;
    document.getElementById("show-scrollbar").checked = settings.showScrollbar;
    document.getElementById("enable-auto-summary").checked = settings.enableAutoSummary;
    // document.getElementById("auto-continue-stream").checked = settings.autoContinueStream;
    document.getElementById("summary-prompt-input").value = settings.summaryPrompt;
    
    const showWelcomeScreenCheckbox = document.getElementById("show-welcome-screen");
    const welcomeSettingsGroup = document.getElementById("welcome-settings-group");
    showWelcomeScreenCheckbox.checked = settings.showWelcomeScreen;
    welcomeSettingsGroup.style.display = settings.showWelcomeScreen ? 'flex' : 'none';
    
    document.getElementById("welcome-title-input").value = settings.welcomeTitle;
    document.getElementById("welcome-subtitle-input").value = settings.welcomeSubtitle;
    document.getElementById("welcome-suggestions-input").value = settings.welcomeSuggestions;
    if (cssEditor && cssEditor.setValue) {
      cssEditor.setValue(settings.customCSS || '');
    }

    const showDisclaimerCheckbox = document.getElementById("show-disclaimer");
    const customDisclaimerGroup = document.getElementById("custom-disclaimer-group");
    const customDisclaimerInput = document.getElementById("custom-disclaimer-input");
    showDisclaimerCheckbox.checked = settings.showDisclaimer;
    customDisclaimerInput.value = settings.disclaimerText;
    customDisclaimerGroup.style.display = settings.showDisclaimer ? 'flex' : 'none';
    document.getElementById("window-title-input").value = settings.windowTitle;
    document.getElementById("enable-network-service").checked = settings.enableNetworkService;
    document.getElementById("proxy-port").value = settings.proxyPort;
    document.getElementById("proxy-port-group").style.display = settings.enableNetworkService ? 'flex' : 'none';

    applyTheme();
    applyFont();
  };

  const applyUISettings = () => {
    body.classList.remove("font-size-small", "font-size-medium", "font-size-large");
    // body.classList.add(`font-size-${settings.fontSize}`);
    body.classList.toggle("compact-mode", settings.compactMode);
    body.classList.toggle("show-avatars", settings.showAvatars);
    body.classList.toggle("animations-disabled", !settings.enableAnimations);
    body.classList.toggle("show-scrollbar", settings.showScrollbar);
    settingsOverlay.classList.toggle("windowed-view", settings.settingsWindowed);
    welcomeTitleEl.textContent = settings.welcomeTitle;
    welcomeSubtitleEl.textContent = settings.welcomeSubtitle;
    renderWelcomeSuggestions();
    
    body.classList.toggle("show-welcome-screen", settings.showWelcomeScreen);
    const welcomeSettingsGroup = document.getElementById("welcome-settings-group");
    if (welcomeSettingsGroup) welcomeSettingsGroup.style.display = settings.showWelcomeScreen ? 'flex' : 'none';

    body.classList.toggle("show-disclaimer", settings.showDisclaimer);
    disclaimerEl.textContent = settings.disclaimerText;

    const customDisclaimerGroup = document.getElementById("custom-disclaimer-group");
    if (customDisclaimerGroup) customDisclaimerGroup.style.display = settings.showDisclaimer ? 'flex' : 'none';

    const proxyPortGroup = document.getElementById("proxy-port-group");
    if (proxyPortGroup) proxyPortGroup.style.display = settings.enableNetworkService ? 'flex' : 'none';

    const autoRunFormatsContainer = document.getElementById("auto-run-formats-container");
    if (autoRunFormatsContainer) autoRunFormatsContainer.style.display = settings.autoRunMode === 'file' ? 'flex' : 'none';

    const allowTauriApiContainer = document.getElementById("allow-tauri-api-container");
    if (allowTauriApiContainer) allowTauriApiContainer.style.display = settings.autoRunMode === 'sandbox' ? 'flex' : 'none';

    renderChat();

    applyCustomCSS();
    updateWindowTitle();
  };

  const applySidebarWidth = () => {
    document.documentElement.style.setProperty('--sidebar-width', `${settings.sidebarWidth}px`);
  };

  const renderWelcomeSuggestions = () => {
    welcomeSuggestionsEl.innerHTML = "";
    const suggestions = settings.welcomeSuggestions.split("\n").filter(s => s.trim() !== "");
    suggestions.forEach(s => {
      const [text, icon] = s.split("|");
      if (!text || text.trim() === "") return;
      const suggestionText = text.trim();
      const suggestionIcon = icon ? icon.trim() : "lightbulb";
      const li = document.createElement("li");
      li.className = "suggestion";
      li.innerHTML = `
        <h4 class="text">${DOMPurify.sanitize(suggestionText)}</h4>
        <span class="icon material-symbols-rounded">${DOMPurify.sanitize(suggestionIcon)}</span>
      `;
      li.addEventListener("click", handleSuggestionClick);
      welcomeSuggestionsEl.appendChild(li);
    });
  };

  const exportSettings = () => {
    const { userAvatar, assistantAvatar, ...exportableSettings } = settings;
    const dataStr = JSON.stringify(exportableSettings, null, 2);
    const blob = new Blob([dataStr], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "neox-settings.json";
    body.appendChild(a);
    a.click();
    body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("设置已导出", "success");
  };

  const importSettings = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = e => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const importedSettings = JSON.parse(event.target.result);
            
            // Validate imported settings
            const validatedSettings = {};
            
            // String fields
            const stringFields = ['theme', 'apiKey', 'apiEndpoint', 'model', 'systemPrompt', 'fontSize',
              'welcomeTitle', 'welcomeSubtitle', 'welcomeSuggestions', 'disclaimerText',
              'customCSS', 'windowTitle', 'summaryPrompt', 'userAvatar', 'assistantAvatar',
              'autoRunMode', 'autoRunFormats'];

            stringFields.forEach(field => {
              if (importedSettings[field] !== undefined && typeof importedSettings[field] === 'string') {
                validatedSettings[field] = importedSettings[field];
              }
            });
            
            // Boolean fields (default true)
            const boolTrueFields = ['displayMarkdown', 'enableStreaming', 'showThinkingProcess', 
              'syntaxHighlighting', 'enableAnimations', 'showActionBtns', 'showWelcomeScreen', 'enableAutoSummary'];
            boolTrueFields.forEach(field => {
              if (importedSettings[field] !== undefined && typeof importedSettings[field] === 'boolean') {
                validatedSettings[field] = importedSettings[field];
              }
            });
            
            // Boolean fields (default false)
            const boolFalseFields = ['settingsWindowed', 'showDialogueInfo', 'allowTauriApi',
              'compactMode', 'showTimestamps', 'showAvatars', 'showDisclaimer', 'enableNetworkService', 'showScrollbar'];
            boolFalseFields.forEach(field => {
              if (importedSettings[field] !== undefined && typeof importedSettings[field] === 'boolean') {
                validatedSettings[field] = importedSettings[field];
              }
            });
            
            // Number fields
            if (importedSettings.maxContextLength !== undefined && 
                typeof importedSettings.maxContextLength === 'number' && 
                importedSettings.maxContextLength > 0 && importedSettings.maxContextLength <= 100) {
              validatedSettings.maxContextLength = importedSettings.maxContextLength;
            }
            
            if (importedSettings.temperature !== undefined && 
                typeof importedSettings.temperature === 'number' && 
                importedSettings.temperature >= 0 && importedSettings.temperature <= 2) {
              validatedSettings.temperature = importedSettings.temperature;
            }
            
            if (importedSettings.proxyPort !== undefined && 
                typeof importedSettings.proxyPort === 'number' && 
                importedSettings.proxyPort > 0 && importedSettings.proxyPort <= 65535) {
              validatedSettings.proxyPort = importedSettings.proxyPort;
            }
            
            if (importedSettings.sidebarWidth !== undefined && 
                typeof importedSettings.sidebarWidth === 'number' && 
                importedSettings.sidebarWidth >= 200 && importedSettings.sidebarWidth <= 400) {
              validatedSettings.sidebarWidth = importedSettings.sidebarWidth;
            }
            
            // Array fields - customModels is an array of model name strings
            if (importedSettings.customModels !== undefined && Array.isArray(importedSettings.customModels)) {
              validatedSettings.customModels = importedSettings.customModels.filter(m => 
                typeof m === 'string' && m.trim() !== ''
              );
            }
            
            // Merge with current settings (validated fields only, keep current values for missing/invalid fields)
            settings = {
              ...settings,
              ...validatedSettings
            };
            await saveSettings();
            await populateSettingsForm();
            applyUISettings();
            showToast("设置导入成功", "success");
          } catch (err) {
            console.error("Error importing settings:", err);
            showToast("导入设置失败: " + err.message, "error");
          }
        };
reader.readAsText(file);
      }
    };
    input.click();
  };

  const resetAllSettings = () => {
    showConfirm("Reset All Settings", "Are you sure you want to reset all settings to their default values? This action cannot be undone.", async () => {
      await storage.removeItem("ai-assistant-settings");
      await storage.removeItem("ai-assistant-prompts");
      await loadSettings();
      await loadPromptLibrary();
      await populateSettingsForm();
      applyUISettings();
      showToast("All settings have been reset to default", "success");
    });
  };

  // --- Session Management ---
  const loadSessions = async () => {
    const storedSessions = (await storage.getItem("ai-assistant-sessions")) || {};
    sessions = {};
    Object.entries(storedSessions).forEach(([id, session]) => {
      if (session && typeof session === 'object') {
        sessions[id] = {
          name: session.name || '未命名聊天',
          history: Array.isArray(session.history) ? session.history : [],
          pinned: Boolean(session.pinned),
          timestamp: session.timestamp || Date.now()
        };
      }
    });
    currentSessionId = await storage.getItem("ai-assistant-current-session");
  };

  const saveSessions = async () => {
    if (isPrivateMode) return;
    await storage.setItem("ai-assistant-sessions", sessions);
    await storage.setItem("ai-assistant-current-session", currentSessionId);
  };

  const togglePrivateMode = (forceState = null) => {
    const newState = forceState !== null ? forceState : !isPrivateMode;

    if (!newState && isPrivateMode) {
      showConfirm("确认退出私密模式", "私密模式下的对话数据将被清除，此操作无法撤销", async () => {
        await setPrivateMode(false);
      });
    } else {
      setPrivateMode(newState);
    }
  };

  const setPrivateMode = async (enabled) => {
    isPrivateMode = enabled;
    body.classList.toggle("private-mode", enabled);
    privateModeIndicator.style.display = enabled ? 'flex' : 'none';
    privateModeIndicator.textContent = enabled ? 'lock_open' : 'lock';

    if (enabled) {
      showToast("私密模式已开启", "info");
    } else {
      sessions = {};
      currentSessionId = null;
      await loadSessions();
      if (!currentSessionId || !sessions[currentSessionId]) {
        createNewSession();
      } else {
        renderSessionList();
        renderChat();
      }
      showToast("私密模式已关闭", "info");
    }
  };

  const showSessionDropdown = (e, sessionId) => {
    const session = sessions[sessionId];
    const rect = e.target.getBoundingClientRect();

    let dropdown = document.getElementById('session-action-dropdown');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = 'session-action-dropdown';
      dropdown.className = 'session-dropdown';
      document.body.appendChild(dropdown);
    }

    // Toggle logic: Close if clicking the same session button while dropdown is open
    if (dropdown.classList.contains('show') && dropdown.dataset.activeSession === sessionId) {
      dropdown.classList.remove('show');
      sessionList.classList.remove('scroll-locked');
      return;
    }
    dropdown.dataset.activeSession = sessionId;

    const pinText = session.pinned ? '取消置顶' : '置顶';

    dropdown.innerHTML = `
      <div class="dropdown-item pin-item">
        <span>${pinText}</span>
      </div>
      <div class="dropdown-item rename-item">
        <span>重命名</span>
      </div>
      <div class="dropdown-item delete-item delete">
        <span>删除</span>
      </div>
    `;

    // Calculate position - Align left edge of dropdown with left edge of the "more" button
    let left = rect.left;
    let top = rect.bottom + 5;

    // Boundary check
    const dropdownWidth = 140;
    if (left + dropdownWidth > window.innerWidth - 10) left = window.innerWidth - dropdownWidth - 10;
    if (left < 10) left = 10;
    if (top + 150 > window.innerHeight) top = rect.top - 130;

    dropdown.style.top = `${top}px`;
    dropdown.style.left = `${left}px`;
    dropdown.classList.add('show');
    sessionList.classList.add('scroll-locked');

    // Event Listeners
    dropdown.querySelector('.pin-item').onclick = (ev) => {
      ev.stopPropagation();
      pinSession(ev, sessionId);
      dropdown.classList.remove('show');
      sessionList.classList.remove('scroll-locked');
    };

    dropdown.querySelector('.rename-item').onclick = (ev) => {
      ev.stopPropagation();
      renameSession(ev, sessionId);
      dropdown.classList.remove('show');
      sessionList.classList.remove('scroll-locked');
    };

    dropdown.querySelector('.delete-item').onclick = (ev) => {
      ev.stopPropagation();
      deleteSession(ev, sessionId);
      dropdown.classList.remove('show');
      sessionList.classList.remove('scroll-locked');
    };

    const closeDropdown = (event) => {
      if (!dropdown.contains(event.target) && event.target !== e.target) {
        dropdown.classList.remove('show');
        sessionList.classList.remove('scroll-locked');
        document.removeEventListener('click', closeDropdown);
      }
    };

    setTimeout(() => {
      document.addEventListener('click', closeDropdown);
    }, 10);
  };

  const switchSession = async (sessionId) => {
    if (sessions[sessionId]) {
      currentSessionId = sessionId;
      renderSessionList();
      renderChat();
      await saveSessions();
      updateInputState();
    }
  };

  const createNewSession = () => {
    const newId = `session_${Date.now()}`;
    sessions[newId] = {
      name: `未命名聊天`,
      history: [],
      pinned: false,
      timestamp: Date.now()
    };
    switchSession(newId);
  };

  const deleteSession = (e, sessionId) => {
    e.stopPropagation();
    if (generatingSessionId === sessionId) {
      showToast("无法删除正在生成的会话", "error");
      return;
    }
    showConfirm("确认删除对话", "此操作无法撤销", async () => {
      if (Object.keys(sessions).length <= 1) {
        showToast("无法删除最后一个对话", "error");
        return;
      }
      delete sessions[sessionId];
      const remainingIds = Object.keys(sessions).sort((a, b) => {
        const lastMsgTimeA = sessions[a].history.length > 0 ? sessions[a].history[sessions[a].history.length - 1].timestamp : sessions[a].timestamp;
        const lastMsgTimeB = sessions[b].history.length > 0 ? sessions[b].history[sessions[b].history.length - 1].timestamp : sessions[b].timestamp;
        if (sessions[a].pinned !== sessions[b].pinned) return sessions[a].pinned ? -1 : 1;
        return lastMsgTimeB - lastMsgTimeA;
      });
      if (currentSessionId === sessionId) {
        await switchSession(remainingIds[0]);
      } else {
        renderSessionList();
      }
      await saveSessions();
      showToast("对话已删除", "success");
    });
  };

  const renameSession = (e, sessionId) => {
    e.stopPropagation();
    showPrompt("输入新的对话名称", sessions[sessionId]?.name || '未命名聊天', async (newName) => {
      if (newName && newName.trim() !== "") {
        sessions[sessionId].name = newName.trim();
        await saveSessions();
        renderSessionList();
        showToast("对话名称已更新", "success");
      }
    });
  };

  const pinSession = async (e, sessionId) => {
    e.stopPropagation();
    sessions[sessionId].pinned = !sessions[sessionId].pinned;
    await saveSessions();
    renderSessionList();
    showToast(sessions[sessionId].pinned ? "对话已置顶" : "对话已取消置顶", "info");
  };

  const clearAllChats = () => {
    if (generatingSessionId) {
      showToast("请先停止当前的生成任务", "error");
      return;
    }
    showConfirm("确认清除所有对话", "此操作无法撤销，所有对话都将被删除", async () => {
      sessions = {};
      currentSessionId = null;
      await saveSessions();
      createNewSession();
      showToast("所有对话已清除", "success");
    });
  };

  const exportAllChats = () => {
    if (Object.keys(sessions).length === 0) {
      showToast("没有可导出的对话", "error");
      return;
    }
    const dataStr = JSON.stringify(sessions, null, 2);
    const blob = new Blob([dataStr], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = `neox-chats-${new Date().toISOString().slice(0, 10)}.json`;
    a.href = url;
    body.appendChild(a);
    a.click();
    body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("所有对话已导出", "success");
  };

  const importAllChats = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = e => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const importedSessions = JSON.parse(event.target.result);
            const validatedSessions = {};
            Object.entries(importedSessions).forEach(([id, session]) => {
              if (session && typeof session === 'object') {
                validatedSessions[id] = {
                  name: session.name || '未命名聊天',
                  history: Array.isArray(session.history) ? session.history : [],
                  pinned: Boolean(session.pinned),
                  timestamp: session.timestamp || Date.now()
                };
              }
            });
            sessions = {
              ...sessions,
              ...validatedSessions
            };
            saveSessions();
            const latestSessionId = Object.keys(sessions).sort((a, b) => {
              const lastMsgTimeA = sessions[a].history.length > 0 ? sessions[a].history[sessions[a].history.length - 1].timestamp : sessions[a].timestamp;
              const lastMsgTimeB = sessions[b].history.length > 0 ? sessions[b].history[sessions[b].history.length - 1].timestamp : sessions[b].timestamp;
              if (sessions[a].pinned !== sessions[b].pinned) return sessions[a].pinned ? -1 : 1;
              return lastMsgTimeB - lastMsgTimeA;
            })[0];
            renderSessionList();
            if (latestSessionId) switchSession(latestSessionId);
            showToast("对话导入成功", "success");
          } catch (err) {
            console.error("Error importing chats:", err);
            showToast("导入对话失败: " + err.message, "error");
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  // --- UI Rendering ---
  const renderSessionList = () => {
    const searchTerm = sessionSearchInput.value.toLowerCase();

    const filtered = Object.entries(sessions).filter(([id, session]) => {
      const name = session.name || '未命名聊天';
      const nameMatch = name.toLowerCase().includes(searchTerm);
      const historyMatch = session.history && session.history.some(msg =>
          msg.content && msg.content.toLowerCase().includes(searchTerm)
      );
      return nameMatch || historyMatch;
    });

    const sorted = filtered.sort((a, b) => {
      const sessionA = a[1];
      const sessionB = b[1];
      if (sessionA.pinned !== sessionB.pinned) return sessionA.pinned ? -1 : 1;
      const lastMsgTimeA = sessionA.history.length > 0 ? sessionA.history[sessionA.history.length - 1].timestamp : sessionA.timestamp;
      const lastMsgTimeB = sessionB.history.length > 0 ? sessionB.history[sessionB.history.length - 1].timestamp : sessionB.timestamp;
      return lastMsgTimeB - lastMsgTimeA;
    });

    if (sorted.length === 0) {
      render(html`<li style="text-align: center; color: var(--subheading-color); padding: 1rem; user-select: none; border: none;">${searchTerm ? '无匹配对话' : '暂无对话'}</li>`, sessionList);
      return;
    }

    const sessionTemplates = sorted.map(([id, session]) => {
      const classes = {
        active: id === currentSessionId,
        'pinned-session': session.pinned
      };

      return html`
        <li class="${classMap(classes)}" @click=${(e) => { if (!e.target.closest('.session-actions')) switchSession(id); }}>
          <span class="session-name">${session.name || '未命名聊天'}</span>
          <div class="session-actions">
            <span class="material-symbols-rounded more-actions" title="更多操作" @click=${(e) => { e.stopPropagation(); showSessionDropdown(e, id); }}>more_horiz</span>
          </div>
        </li>
      `;
    });

    render(html`${sessionTemplates}`, sessionList);
  };

  const renderChat = () => {
    const session = sessions[currentSessionId];
    if (session) {
      render(html`${repeat(session.history, (m) => m.id || m.timestamp, (message, index) => {
        const {
          role,
          content,
          thinking,
          timestamp,
          feedbackSubmitted,
          dialogueInfo,
          id,
          images
        } = message;

        const isAssistant = role === 'assistant';
        const isUser = role === 'user';
        const isEditing = editingIndex === index;
        const avatarIcon = isUser ? 'person' : 'smart_toy';
        const customAvatar = isUser ? settings.userAvatar : settings.assistantAvatar;
        const isGeneratingThis = generatingSessionId === currentSessionId && index === session.history.length - 1;

        // Content rendering logic
        let messageContent;
        if (isEditing) {
          messageContent = html`
            <div class="edit-container">
              <textarea 
                class="glass-input edit-textarea" 
                .value=${content}
                @input=${(e) => {
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
              ></textarea>
              <div class="edit-buttons">
                <button class="glass-button modal-cancel-btn" @click=${cancelEdit}>取消</button>
                <button class="glass-button modal-confirm-btn accent-button" @click=${() => confirmEdit(index)}>确认</button>
              </div>
            </div>
          `;
        } else if (isAssistant) {

          if (!content && !thinking && !dialogueInfo && isGeneratingThis) {
            messageContent = html`<div class="text"><div class="loading-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`;
          } else if (settings.displayMarkdown) {
            // Using guard here to prevent re-parsing markdown if content hasn't changed
            messageContent = html`<div class="text markdown-body">${guard([content], () => unsafeHTML(DOMPurify.sanitize(marked.parse(content || ''))))}</div>`;
        } else {
          const sanitizedContent = (content || '').replace(/</g, "&lt;").replace(/>/g, "&gt;");
          messageContent = html`<div class="text">${unsafeHTML(sanitizedContent.replace(/\n/g, '<br>'))}</div>`;
        }
        } else {
          const sanitizedContent = (content || '').replace(/</g, "&lt;").replace(/>/g, "&gt;");
          messageContent = html`<div class="text">${unsafeHTML(sanitizedContent.replace(/\n/g, '<br>'))}</div>`;
        }

        const thinkingTemplate = isAssistant && thinking && settings.showThinkingProcess ? html`
          <div class="thinking-process">
            <div class="thinking-content-wrapper ${isGeneratingThis ? '' : 'collapsed'}">
              <div class="thinking-header" @click=${(e) => e.currentTarget.parentElement.classList.toggle('collapsed')}>
                <span class="material-symbols-rounded">expand_more</span>
                思考过程
              </div>
              <div class="thinking-content markdown-body">${guard([thinking], () => unsafeHTML(DOMPurify.sanitize(marked.parse(thinking))))}</div>
            </div>
          </div>
        ` : '';

        const imagesTemplate = images && images.length > 0 ? html`
          <div class="message-images-container">
            ${images.map(img => html`<img src="data:image/png;base64,${img}" class="attached-image" title="Click to preview" @click=${() => openLightbox(`data:image/png;base64,${img}`)}> `)}
          </div>
        ` : '';

        const dialogueInfoTemplate = isAssistant && dialogueInfo && settings.showDialogueInfo ? html`
          <div class="dialogue-info">
            <span><span class="material-symbols-rounded" style="font-size: inherit;">bolt</span> ${dialogueInfo.tokensPerSecond} token/s</span>
            <span><span class="material-symbols-rounded" style="font-size: inherit;">timer</span> ${dialogueInfo.timeToFirstToken}s (First response)</span>
            <span>${dialogueInfo.totalTime}s (总计)</span>
            <span>${dialogueInfo.model}</span>
          </div>
        ` : '';

        const footerActionsTemplate = settings.showActionBtns ? html`
          <div class="action-btns">
            <button class="icon copy" title="Copy" @click=${() => copyToClipboard(content)}><span class="material-symbols-rounded">content_copy</span></button>
            <button class="icon edit-prompt" title="Edit message" @click=${() => editMessage(index)}><span class="material-symbols-rounded">edit</span></button>
            ${isAssistant ? html`
              <button class="icon regenerate" title="Regenerate" @click=${() => regenerateResponse(index)}><span class="material-symbols-rounded">refresh</span></button>
              <button class="icon thumb-up ${feedbackSubmitted === 'like' ? 'active' : ''}" title="喜欢" data-feedback-type="like" data-message-index="${index}" ?disabled=${!!feedbackSubmitted} @click=${handleFeedback}><span class="material-symbols-rounded">thumb_up</span></button>
              <button class="icon thumb-down ${feedbackSubmitted === 'dislike' ? 'active' : ''}" title="不喜欢" data-feedback-type="dislike" data-message-index="${index}" ?disabled=${!!feedbackSubmitted} @click=${handleFeedback}><span class="material-symbols-rounded">thumb_down</span></button>
            ` : ''}
          </div>
        ` : '';

        const avatarClickHandler = () => {
          const avatarInput = document.getElementById('avatar-file-input');
          avatarInput.dataset.role = isUser ? 'user' : 'assistant';
          avatarInput.click();
        };

        return html`
          <div id=${id ? `msg-${id}` : ''} class="message ${role === 'user' ? 'outgoing' : 'incoming'}">
            <div class="avatar" @click=${avatarClickHandler}>
              ${customAvatar ? html`<img src="${customAvatar}" class="avatar-image">` : html`<span class="material-symbols-rounded">${avatarIcon}</span>`}
            </div>
            <div class="message-content">
              ${thinkingTemplate}
              ${imagesTemplate}
              ${messageContent}
              ${settings.showTimestamps && timestamp ? html`<span class="timestamp" style="font-size: 0.75rem; color: var(--placeholder-color); margin-top: 0.25rem; display: block;">${new Date(timestamp).toLocaleString()}</span>` : ''}
              ${(!isEditing && (dialogueInfoTemplate || footerActionsTemplate)) ? html`
                <div class="message-footer">
                  ${dialogueInfoTemplate}
                  ${footerActionsTemplate}
                </div>
              ` : ''}
            </div>
          </div>
        `;
      })}`, chatContainer);
      
      body.classList.toggle("hide-header", session.history.length > 0);
      if (isAutoScrollEnabled) {
        chatView.scrollTop = chatView.scrollHeight;
      }
      
      processCodeBlocks(chatContainer);
      updateInputState();
    } else {
      render(html``, chatContainer);
      body.classList.remove("hide-header");
    }
  };

  // We no longer need a separate createMessageElement
  // Removing it along with its original definition.
  
  const addCopyButtonToPre = (pre) => {
    if (pre.querySelector('.copy-code-btn')) return;

    const codeEl = pre.querySelector('code');
    if (!codeEl) return;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-code-btn';
    copyBtn.innerHTML = `<span class="material-symbols-rounded">content_copy</span><span>Copy</span>`;
    copyBtn.title = 'Copy code';

    copyBtn.addEventListener('click', () => {
      const codeToCopy = codeEl.textContent;
      navigator.clipboard.writeText(codeToCopy).then(() => {
        copyBtn.querySelector('span:last-child').textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.querySelector('span:last-child').textContent = 'Copy';
        }, 2000);
      }).catch(err => {
        showToast('Failed to copy code.', 'error');
        console.error('Copy failed', err);
      });
    });
    pre.appendChild(copyBtn);
  }

  // --- File Handling ---
  const addEventListenersForDragDrop = () => {
    let dragCounter = 0;

    mainContent.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      mainContent.classList.add('drag-over');
    });

    mainContent.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    mainContent.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter === 0) {
        mainContent.classList.remove('drag-over');
      }
    });

    mainContent.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      mainContent.classList.remove('drag-over');

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        handleFiles(files);
      }
    });
  };

  const handlePaste = (e) => {
    const items = e.clipboardData.items;
    const files = [];
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      handleFiles(files);
    }
  };

  const openLightbox = (src) => {
    if (!lightboxOverlay || !lightboxImage) return;
    lightboxScale = 1;
    lightboxImage.style.transform = `scale(${lightboxScale})`;
    lightboxImage.src = src;
    lightboxOverlay.classList.add('show');
    body.style.overflow = 'hidden';
  };

  const closeLightbox = () => {
    if (!lightboxOverlay) return;
    lightboxOverlay.classList.remove('show');
    body.style.overflow = '';
    setTimeout(() => {
      if (lightboxImage) {
        lightboxImage.src = '';
        lightboxScale = 1;
        lightboxImage.style.transform = `scale(${lightboxScale})`;
      }
    }, 300);
  };

  const handleFileSelect = (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      handleFiles(files);
    }
    fileInput.value = '';
  };

  const handleFiles = (files) => {
    for (const file of files) {
      attachedFiles.push(file);
    }
    renderFilePreview();
  };

  let previewObjectUrls = new Set();

  const renderFilePreview = () => {
    // Clean up old object URLs to prevent memory leaks
    previewObjectUrls.forEach(url => URL.revokeObjectURL(url));
    previewObjectUrls.clear();

    filePreviewContainer.innerHTML = '';
    body.classList.toggle('has-files', attachedFiles.length > 0);

    if (attachedFiles.length > 0) {
      attachedFiles.forEach((file, index) => {
        const chip = document.createElement('div');
        chip.className = 'file-chip';

        let previewHtml = '';
        if (file.type.startsWith('image/')) {
          const url = URL.createObjectURL(file);
          previewObjectUrls.add(url);
          previewHtml = `<img src="${url}" class="thumbnail" title="Click to preview">`;
        }

        chip.innerHTML = `
            ${previewHtml}
            <span>${DOMPurify.sanitize(file.name)}</span>
            <button class="remove-file-btn" data-index="${index}" title="Remove file"><span class="material-symbols-rounded">close</span></button>
        `;

        if (file.type.startsWith('image/')) {
          chip.querySelector('.thumbnail').onclick = () => openLightbox(URL.createObjectURL(file));
        }

        chip.querySelector('.remove-file-btn').addEventListener('click', removeAttachedFile);
        filePreviewContainer.appendChild(chip);
      });
    }
    updateInputState();
  };

  const removeAttachedFile = (event) => {
    const index = parseInt(event.currentTarget.dataset.index, 10);
    if (!isNaN(index)) {
      attachedFiles.splice(index, 1);
      renderFilePreview();
    }
  };

  const clearAttachedFiles = () => {
    attachedFiles = [];
    renderFilePreview();
  };

  const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result.split(',')[1];
        resolve(base64String);
      };
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(file);
    });
  };

  const processFile = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        let fileContentHTML = '';
        if (file.type.startsWith('image/')) {
          fileContentHTML = `<br><img src="${e.target.result}" alt="${file.name}" class="attached-image">`;
        } else if (file.type.startsWith('text/')) {
          const textContent = e.target.result;
          const sanitizedText = textContent.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          fileContentHTML = `\n\n--- ${file.name} ---\n<div class="attached-file-content">${sanitizedText}</div>`;
        } else {
          fileContentHTML = `\n\n[File Attached: ${file.name}]`;
        }
        resolve(fileContentHTML);
      };
      reader.onerror = (error) => reject(error);

      if (file.type.startsWith('image/')) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  };

  // --- Avatar Image Processing ---
  const processAvatarImage = (file) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 50;
          canvas.height = 50;
          const ctx = canvas.getContext('2d');

          // Draw image with cover mode (center crop)
          const scale = Math.max(50 / img.width, 50 / img.height);
          const x = (50 - img.width * scale) / 2;
          const y = (50 - img.height * scale) / 2;
          ctx.drawImage(img, x, y, img.width * scale, img.height * scale);

          // Convert to PNG base64
          const dataUrl = canvas.toDataURL('image/png');
          resolve(dataUrl);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleAvatarUpload = async (file, role) => {
    if (!file || !file.type.startsWith('image/')) {
      showToast('请选择有效的图片文件', 'error');
      return;
    }

    try {
      const compressedImage = await processAvatarImage(file);
      if (role === 'user') {
        settings.userAvatar = compressedImage;
      } else {
        settings.assistantAvatar = compressedImage;
      }
      await saveSettings();
      renderChat();
      showToast('头像更新成功', 'success');
    } catch (error) {
      console.error('Avatar upload failed:', error);
      showToast('头像上传失败，请重试', 'error');
    }
  };

  // --- Chat Logic ---
  const handleSendMessage = async (event, options = {}) => {
    event?.preventDefault();

    if (!settings.model) {
      showToast("请在设置中选择或添加一个模型", "error");
      return;
    }

    if (generatingSessionId) {
      showToast("AI正在生成中，请稍候", "info");
      return;
    }

    const {
      overridePrompt,
      isRegeneration = false
    } = options;
    let userPrompt = (overridePrompt || typingInput.value).trim();

    if (!userPrompt && attachedFiles.length === 0) {
      typingInput.focus();
      return;
    }

    const requestSessionId = currentSessionId;

    generatingSessionId = requestSessionId;
    abortController = new AbortController();
    updateInputState();

    const startTime = Date.now();
    let firstChunkTime = null;

    const userMsgId = generateMessageId();
    const assistantMsgId = generateMessageId();

    const onFirstChunk = () => {
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
      }
    };

    try {
      let imagesBase64 = [];
      if (!isRegeneration && attachedFiles.length > 0) {
        const imageFiles = attachedFiles.filter(f => f.type.startsWith('image/'));
        const otherFiles = attachedFiles.filter(f => !f.type.startsWith('image/'));

        // Handle images separately for multimodal support
        if (imageFiles.length > 0) {
          imagesBase64 = await Promise.all(imageFiles.map(file => fileToBase64(file)));
        }

        // Handle other files as text attachments in the prompt
        if (otherFiles.length > 0) {
          const fileProcessingPromises = otherFiles.map(file => processFile(file));
          const fileHTMLs = await Promise.all(fileProcessingPromises);
          userPrompt += fileHTMLs.join('');
        }
      }

      typingInput.value = "";
      resizeTextarea();
      clearAttachedFiles();

      if (!isRegeneration) {
        const userMessage = {
          role: "user",
          content: userPrompt,
          timestamp: Date.now(),
          id: userMsgId
        };

        if (imagesBase64.length > 0) {
          userMessage.images = imagesBase64;
        }

        sessions[requestSessionId].history.push(userMessage);
      }

      await saveSessions();
      if (currentSessionId === requestSessionId) renderChat();

      sessions[requestSessionId].history.push({
        role: "assistant",
        content: '',
        id: assistantMsgId,
        timestamp: Date.now()
      });

      if (currentSessionId === requestSessionId) renderChat();

      const rawResponse = await getAIResponse(requestSessionId, assistantMsgId, onFirstChunk);

      const {
        thinking,
        content
      } = parseThinkContent(rawResponse);

      const endTime = Date.now();
      const totalTime = (endTime - startTime) / 1000;
      const timeToFirstToken = firstChunkTime ? ((firstChunkTime - startTime) / 1000).toFixed(2) : (totalTime / 3).toFixed(2);
      const simulatedTokenCount = (rawResponse.length / 4);
      const tokensPerSecond = totalTime > 0 ? (simulatedTokenCount / totalTime).toFixed(1) : "N/A";

      const dialogueInfo = {
        tokensPerSecond: tokensPerSecond,
        timeToFirstToken: timeToFirstToken,
        totalTime: totalTime.toFixed(2),
        model: settings.model
      };

      const histIndex = sessions[requestSessionId].history.findIndex(m => m.id === assistantMsgId);
      if (histIndex !== -1) {
        sessions[requestSessionId].history[histIndex] = {
          ...sessions[requestSessionId].history[histIndex],
          content: content,
          thinking: thinking,
          dialogueInfo: dialogueInfo
        }
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        const histIndex = sessions[requestSessionId].history.findIndex(m => m.id === assistantMsgId);
        const lastMsg = histIndex !== -1 ? sessions[requestSessionId].history[histIndex] : null;

        const {
          thinking,
          content
        } = lastMsg ? parseThinkContent(lastMsg.content || "") : { thinking: null, content: "" };

        const dialogueInfo = {
          tokensPerSecond: "N/A",
          timeToFirstToken: "N/A",
          totalTime: "Stopped",
          model: settings.model
        };

        if (histIndex !== -1) {
          sessions[requestSessionId].history[histIndex] = {
            ...lastMsg,
            content: content || "已停止生成",
            thinking: thinking,
            dialogueInfo: dialogueInfo
          }
        }
        showToast("生成已停止", "info");
      } else {
        console.error("Error sending message:", error);

        const histIndex = sessions[requestSessionId].history.findIndex(m => m.id === assistantMsgId);

        if (histIndex !== -1) {
          sessions[requestSessionId].history[histIndex] = {
            ...sessions[requestSessionId].history[histIndex],
            content: `抱歉，出错了: ${error.message}`,
            isError: true,
            thinking: null,
            dialogueInfo: null
          };
        } else {
          sessions[requestSessionId].history.push({
            role: "assistant",
            content: `系统初始化错误: ${error.message}`,
            timestamp: Date.now(),
            id: generateMessageId(),
            isError: true
          });
        }

        showToast(`Error: ${error.message}`, "error");
      }
    } finally {
      if (streamAnimationFrameId) {
        cancelAnimationFrame(streamAnimationFrameId);
        streamAnimationFrameId = null;
      }
      generatingSessionId = null;
      updateInputState();
      await saveSessions();
      if (currentSessionId === requestSessionId) renderChat();

      if (assistantMsgId && sessions[requestSessionId]) {
        // Trigger Auto Run if enabled
        if (settings.autoRunMode && settings.autoRunMode !== 'none') {
          setTimeout(() => {
            const msgEl = document.getElementById(`msg-${assistantMsgId}`);
            if (msgEl) {
              if (settings.autoRunMode === 'sandbox') {
                const firstJS = msgEl.querySelector('pre code.language-javascript, pre code.language-js');
                if (firstJS) {
                  executeJS(firstJS.textContent);
                }
              } else if (settings.autoRunMode === 'file') {
                const formatsStr = settings.autoRunFormats || "html";
                const formats = formatsStr.split(',').map(f => f.trim().toLowerCase()).filter(f => f);

                for (const format of formats) {
                  const codeEl = msgEl.querySelector(`pre code.language-${format}`);
                  if (codeEl) {
                    if (window.__TAURI__) {
                      window.__TAURI__.core.invoke('run_code_as_file', {
                        content: codeEl.textContent,
                        extension: format
                      }).catch(err => {
                        console.error("Failed to run code as file:", err);
                        showToast("无法打开文件", "error");
                      });
                    }
                    break;
                  }
                }
              }
            }
          });
        }


        // Trigger Auto Summary if applicable
        if (settings.enableAutoSummary &&
            (sessions[requestSessionId]?.name === "未命名聊天" || sessions[requestSessionId]?.name === "Chat") &&
            sessions[requestSessionId].history.length >= 2) {
          summarizeSession(requestSessionId);
        }

        streamingRenderers.delete(assistantMsgId);
        lastContentLength.delete(assistantMsgId);
        messageBuffers.delete(assistantMsgId);
      }
    }
  };

  const isStreamFinished = (data, dataPayload) => {
    // OpenAI/Anthropic/Common SSE finish_reason
    if (data?.choices?.[0]?.finish_reason && data.choices[0].finish_reason !== 'null') {
      return true;
    }
    // Ollama style
    if (data?.done === true) {
      return true;
    }
    // DeepSeek style
    if (data?.finish_reason && data.finish_reason !== 'null') {
      return true;
    }
    // SSE Protocol level
    if (dataPayload === '[DONE]') {
      return true;
    }
    return false;
  };

  const getAIResponse = async (requestSessionId, messageId, onFirstChunk, continuationCount = 0) => {
    let fullResponse = "";
    let streamActuallyFinished = false;

    if (!settings.apiEndpoint) throw new Error("API端点未设置，请在设置中添加");

    const history = (sessions[requestSessionId]?.history || [])
        .slice(0, continuationCount > 0 ? undefined : -1)
        .filter(msg => msg.role !== 'error')
        .slice(-settings.maxContextLength);

    const isOllamaEndpoint = settings.apiEndpoint.includes("/api/chat");

    const messages = [
      {
        role: "system",
        content: settings.systemPrompt
      },
      ...history.map(msg => {
        let content = msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        if (msg.images && msg.images.length > 0) {
          if (isOllamaEndpoint) {
            return {
              role: msg.role,
              content: content,
              images: msg.images
            };
          } else {
            const contentArray = [
              { type: "text", text: content }
            ];
            msg.images.forEach(base64 => {
              contentArray.push({
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${base64}`
                }
              });
            });
            return {
              role: msg.role,
              content: contentArray
            };
          }
        } else {
          return {
            role: msg.role,
            content: content
          };
        }
      }),
    ];

    const requestData = {
      model: settings.model,
      messages: messages,
      stream: settings.enableStreaming,
      options: {
        temperature: settings.temperature
      }
    };

    const useStreaming = settings.enableStreaming;

    try {
      if (useStreaming && window.__TAURI__) {
        currentStreamId = Date.now().toString();

        return new Promise((resolve, reject) => {
          let sseBuffer = "";
          let isFinalized = false;

          const cleanup = async () => {
            if (isFinalized) return;
            isFinalized = true;

            if (streamChunkListener) {
              const unlisten = await streamChunkListener;
              unlisten();
              streamChunkListener = null;
            }
            if (streamErrorListener) {
              const unlisten = await streamErrorListener;
              unlisten();
              streamErrorListener = null;
            }
            abortController.signal.removeEventListener('abort', handleAbort);
          };

          const handleAbort = () => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
          };

          abortController.signal.addEventListener('abort', handleAbort);

          const handleStreamChunk = (event) => {
            if (isFinalized || abortController.signal.aborted) return;

            const chunk = event.payload;
            if (chunk === undefined || chunk === null) return;

            sseBuffer += chunk;

            let boundary = sseBuffer.indexOf("\n\n");
            while (boundary !== -1) {
              const block = sseBuffer.slice(0, boundary);
              sseBuffer = sseBuffer.slice(boundary + 2);

              const lines = block.split("\n");
              let dataPayload = "";
              for (let line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith("data: ")) {
                  dataPayload += trimmed.slice(6);
                } else if (trimmed !== "data:" && trimmed !== "") {
                  dataPayload += trimmed;
                }
              }

              if (dataPayload === "[DONE]") {
                streamActuallyFinished = true;
              }

              if (dataPayload && dataPayload !== "[DONE]") {
                try {
                  const data = JSON.parse(dataPayload);
                  if (isStreamFinished(data, dataPayload)) {
                    streamActuallyFinished = true;
                  }
                  const content = data.choices?.[0]?.delta?.content || data.message?.content || "";
                  if (content) {
                    fullResponse += content;
                    onFirstChunk();

                    const histIndex = sessions[requestSessionId].history.findIndex(m => m.id === messageId);
                    if (histIndex !== -1) {
                      sessions[requestSessionId].history[histIndex].content = fullResponse;

                      if (currentSessionId === requestSessionId) {
                        if (!streamAnimationFrameId) {
                          streamAnimationFrameId = requestAnimationFrame(() => {
                            updateStreamingMessageDOM(messageId, fullResponse);
                            streamAnimationFrameId = null;
                          });
                        }
                      }
                    }
                  }
                } catch (e) {
                  if (dataPayload && !dataPayload.startsWith("{")) {
                    fullResponse += dataPayload;
                    onFirstChunk();
                    const histIndex = sessions[requestSessionId].history.findIndex(m => m.id === messageId);
                    if (histIndex !== -1) {
                      sessions[requestSessionId].history[histIndex].content = fullResponse;
                      if (currentSessionId === requestSessionId) {
                        if (!streamAnimationFrameId) {
                          streamAnimationFrameId = requestAnimationFrame(() => {
                            updateStreamingMessageDOM(messageId, fullResponse);
                            streamAnimationFrameId = null;
                          });
                        }
                      }
                    }
                  }
                }
              }
              boundary = sseBuffer.indexOf("\n\n");
            }
          };

          const handleStreamError = (event) => {
            cleanup();
            reject(new Error(event.payload || 'Unknown streaming error occurred'));
          };

          streamChunkListener = window.__TAURI__.event.listen(`stream-${currentStreamId}`, handleStreamChunk);
          streamErrorListener = window.__TAURI__.event.listen(`stream-error-${currentStreamId}`, handleStreamError);

          window.__TAURI__.core.invoke('send_chat_stream', {
            apiEndpoint: settings.apiEndpoint,
            apiKey: settings.apiKey || null,
            request: requestData,
            streamId: currentStreamId
          }).then(async () => {
            if (!isFinalized) {
              cleanup();

              if (!streamActuallyFinished && settings.autoContinueStream && continuationCount < 3) {
                console.log(`Stream interrupted (Tauri), attempting to continue (${continuationCount + 1}/3)...`);
                showToast("检测到响应中断，正在尝试继续...", "info");

                // Brief delay before continuing
                await new Promise(resolve => setTimeout(resolve, 800));

                // The history already contains the partial assistant response
                const nextPart = await getAIResponse(requestSessionId, messageId, onFirstChunk, continuationCount + 1);
                resolve(fullResponse + nextPart);
              } else {
                resolve(fullResponse);
              }
            }
          }).catch((error) => {
            if (!isFinalized) {
              cleanup();
              reject(error);
            }
          });
        });
      } else {
        if (window.__TAURI__) {
          const content = await window.__TAURI__.core.invoke('send_chat_request', {
            apiEndpoint: settings.apiEndpoint,
            apiKey: settings.apiKey || null,
            request: requestData
          });
          return content;
        } else {
          return await getAIResponseFetch(requestSessionId, messageId, onFirstChunk, requestData, continuationCount);
        }
      }
    } catch (error) {
      throw new Error(`请求失败: ${error.message || error}`);
    }
  };

  // Fallback fetch function for non-Tauri environments
  const getAIResponseFetch = async (requestSessionId, messageId, onFirstChunk, requestData, continuationCount = 0) => {
    let fullResponse = "";
    let streamActuallyFinished = false;

    const headers = {
      "Content-Type": "application/json"
    };
    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const useStreaming = requestData.stream;

    const response = await fetch(settings.apiEndpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(requestData),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorData = JSON.parse(errorText);
        throw new Error(errorData.error?.message || errorData.error || `API 错误: ${response.status} ${response.statusText}`);
      } catch (e) {
        throw new Error(errorText || `API 错误: ${response.status} ${response.statusText}`);
      }
    }

    if (useStreaming && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        let boundary = sseBuffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = sseBuffer.slice(0, boundary);
          sseBuffer = sseBuffer.slice(boundary + 2);

          if (generatingSessionId !== requestSessionId) return fullResponse;

          const lines = block.split('\n');
          let dataPayload = "";
          for (let line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              dataPayload += trimmed.slice(6);
            } else if (trimmed !== 'data:' && trimmed !== '') {
              dataPayload += trimmed;
            }
          }

          if (dataPayload === '[DONE]') {
            streamActuallyFinished = true;
          }

          if (dataPayload && dataPayload !== '[DONE]') {
            try {
              const data = JSON.parse(dataPayload);
              if (isStreamFinished(data, dataPayload)) {
                streamActuallyFinished = true;
              }
              const chunk = data.choices ? (data.choices[0]?.delta?.content || "") : (data.message?.content || "");

              if (chunk) {
                onFirstChunk();
                fullResponse += chunk;

                const histIndex = sessions[requestSessionId].history.findIndex(m => m.id === messageId);
                if (histIndex !== -1) {
                  sessions[requestSessionId].history[histIndex].content = fullResponse;

                  if (currentSessionId === requestSessionId) {
                    if (!streamAnimationFrameId) {
                      streamAnimationFrameId = requestAnimationFrame(() => {
                        updateStreamingMessageDOM(messageId, fullResponse);
                        streamAnimationFrameId = null;
                      });
                    }
                  }
                }
              }
            } catch (e) {
              if (dataPayload && !dataPayload.startsWith('{')) {
                fullResponse += dataPayload;
                onFirstChunk();
                const histIndex = sessions[requestSessionId].history.findIndex(m => m.id === messageId);
                if (histIndex !== -1) {
                  sessions[requestSessionId].history[histIndex].content = fullResponse;
                  if (currentSessionId === requestSessionId) {
                    if (!streamAnimationFrameId) {
                      streamAnimationFrameId = requestAnimationFrame(() => {
                        updateStreamingMessageDOM(messageId, fullResponse);
                        streamAnimationFrameId = null;
                      });
                    }
                  }
                }
              }
            }
          }
          boundary = sseBuffer.indexOf('\n\n');
        }
      }

      if (useStreaming && !streamActuallyFinished && settings.autoContinueStream && continuationCount < 3) {
        console.log(`Stream interrupted, attempting to continue (${continuationCount + 1}/3)...`);
        showToast("检测到响应中断，正在尝试继续...", "info");
        
        // Brief delay before continuing
        await new Promise(resolve => setTimeout(resolve, 800));
        
        // Recursively call getAIResponse with incremented continuationCount
        // The history already contains the partial assistant response
        const nextPart = await getAIResponse(requestSessionId, messageId, onFirstChunk, continuationCount + 1);
        return fullResponse + nextPart;
      }

      return fullResponse;
    } else {
      const data = await response.json();
      const content = data.choices ? (data.choices[0]?.message?.content || "") : (data.message?.content || "");
      return content;
    }
  };

  const processCodeBlocks = (contentDiv) => {
    contentDiv.querySelectorAll('pre:not(:has(.copy-code-btn))').forEach(pre => {
      addCopyButtonToPre(pre);
    });

    if (settings.syntaxHighlighting && window.hljs) {
      contentDiv.querySelectorAll('pre code:not(.hljs)').forEach((block) => {
        try {
          hljs.highlightElement(block);
        } catch (e) {
          console.warn('代码高亮失败:', e);
        }
      });
    }
  };

  const parseThinkContent = (rawContent) => {
    const thinkRegex = /<think>([\s\S]*?)<\/think>/;
    const match = rawContent.match(thinkRegex);
    if (match) {
      const thinking = match[1].trim();
      const content = rawContent.replace(thinkRegex, "").trim();
      return {
        thinking,
        content
      };
    }
    const openThinkRegex = /<think>([\s\S]*?)$/;
    const openMatch = rawContent.match(openThinkRegex);
    if (openMatch) {
      return {
        thinking: openMatch[1].trim(),
        content: ""
      }
    }

    return {
      thinking: null,
      content: rawContent
    };
  };

  const updateStreamingMessageDOM = (messageId, rawContent) => {
    // With lit-html, we just update the state and call renderChat.
    // The diffing engine handles the rest efficiently.
    renderChat();
  };

  const regenerateResponse = (messageIndex) => {
    const userMessageIndex = messageIndex - 1;
    if (userMessageIndex < 0 || generatingSessionId) return;

    const userPrompt = sessions[currentSessionId].history[userMessageIndex].content;
    sessions[currentSessionId].history.splice(userMessageIndex + 1);
    handleSendMessage(null, {
      overridePrompt: userPrompt,
      isRegeneration: true
    });
  };

  const editMessage = (index) => {
    if (generatingSessionId) return;
    editingIndex = index;
    renderChat();
    
    // Auto-focus and resize the textarea
    setTimeout(() => {
      const textarea = chatContainer.querySelector(`.message:nth-child(${index + 1}) .edit-textarea`);
      if (textarea) {
        textarea.focus();
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
        // Move cursor to end
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      }
    }, 0);
  };

  const cancelEdit = () => {
    editingIndex = null;
    renderChat();
  };

  const confirmEdit = async (index) => {
    const textarea = chatContainer.querySelector(`.message:nth-child(${index + 1}) .edit-textarea`);
    if (!textarea) return;
    
    const newContent = textarea.value.trim();
    const originalMessage = sessions[currentSessionId].history[index];
    const originalContent = originalMessage.content;
    
    editingIndex = null;
    
    if (newContent !== "" && newContent !== originalContent) {
      if (originalMessage.role === 'user') {
        sessions[currentSessionId].history.splice(index);
        await handleSendMessage(null, {
          overridePrompt: newContent
        });
      } else {
        originalMessage.content = newContent;
        await saveSessions();
        renderChat();
      }
    } else {
      renderChat();
    }
  };


  const summarizeSession = async (sessionId) => {
    const session = sessions[sessionId];
    if (!session || !settings.enableAutoSummary || !settings.model) return;

    // Use a subset of history for summary to avoid context limits
    const historyForSummary = session.history.slice(0, 4).map(msg => ({
      role: msg.role,
      content: (typeof msg.content === "string" ? msg.content : "").replace(/<think>[\s\S]*?<\/think>/g, "").trim()
    })).filter(msg => msg.content);

    if (historyForSummary.length === 0) return;

    const messages = [
      ...historyForSummary,
      {
        role: "user",
        content: settings.summaryPrompt
      }
    ];

    try {
      if (window.__TAURI__) {
        const response = await window.__TAURI__.core.invoke("send_chat_request", {
          apiEndpoint: settings.apiEndpoint,
          apiKey: settings.apiKey || null,
          request: {
            model: settings.model,
            messages: messages,
            stream: false,
            options: { temperature: 0.3 }
          }
        });

        if (response && response.trim()) {
          let newName = response.trim().replace(/^["'""]|["'""]$/g, ""); // Remove quotes if any
          if (newName.length > 50) newName = newName.substring(0, 47) + "...";
          session.name = newName;
          await saveSessions();
          renderSessionList();
        }
      } else {
        const headers = { "Content-Type": "application/json" };
        if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

        const response = await fetch(settings.apiEndpoint, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            model: settings.model,
            messages: messages,
            stream: false,
            options: { temperature: 0.3 }
          })
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices ? (data.choices[0]?.message?.content || "") : (data.message?.content || "");
          if (content && content.trim()) {
            let newName = content.trim().replace(/^["'""]|["'""]$/g, "");
            if (newName.length > 50) newName = newName.substring(0, 47) + "...";
            session.name = newName;
            await saveSessions();
            renderSessionList();
          }
        }
      }
    } catch (error) {
      console.error("Failed to summarize session:", error);
    }
  };

  // --- UI Helpers ---
  const toggleSidebar = () => {
    const isCurrentlyClosed = body.classList.contains("sidebar-closed");

    if (isCurrentlyClosed) {
      body.classList.remove("sidebar-closed");
      body.classList.add("sidebar-open");
      sidebarToggleBtn.classList.add("active");
      sidebarToggleBtn.setAttribute("aria-expanded", "true");
    } else {
      body.classList.add("sidebar-closed");
      body.classList.remove("sidebar-open");
      sidebarToggleBtn.classList.remove("active");
      sidebarToggleBtn.setAttribute("aria-expanded", "false");
    }
  };

  const openSettingsPanel = async () => {
    closeLightbox();
    const existingModal = document.getElementById("custom-modal-overlay");
    if (existingModal) existingModal.remove();
    await populateSettingsForm();
    body.classList.add("settings-open");
    settingsOverlay.style.display = 'flex';
    const activeNavItem = document.querySelector(".settings-nav-item.active") || document.querySelector(".settings-nav-item");
    if (activeNavItem) activeNavItem.click();
  };

  const closeSettingsPanel = () => {
    body.classList.remove("settings-open");
    settingsOverlay.style.display = 'none';
  };

  const handleSuggestionClick = (e) => {
    const prompt = e.currentTarget.querySelector(".text").textContent;
    typingInput.value = prompt;
    handleSendMessage(new Event('submit'), {});
  };

  const handleEnterKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      typingForm.dispatchEvent(new Event("submit", {
        cancelable: true,
        bubbles: true
      }));
    }
  };

  const resizeTextarea = () => {
    if (resizeAnimationFrameId) return;
    resizeAnimationFrameId = requestAnimationFrame(() => {
      typingInput.style.height = "auto";
      typingInput.style.height = `${typingInput.scrollHeight}px`;
      updateInputState();
      resizeAnimationFrameId = null;
    });
  };

  const copyToClipboard = (text) => {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = text;
    const plainText = tempDiv.textContent || tempDiv.innerText || "";

    navigator.clipboard.writeText(plainText)
        .then(() => showToast("已复制到剪贴板", "success"))
        .catch(err => {
          console.error("Failed to copy: ", err);
          showToast("复制失败", "error");
        });
  };

  /**
   * Executes AI-generated JavaScript in a separate window with configurable Tauri API access.
   * Ensures production-grade isolation and logic.
   * @param {string} code - The JavaScript code to execute
   */
  const executeJS = async (code) => {
    if (!code || code.trim() === "") {
      showToast("没有可执行的代码", "info");
      return;
    }

    // Determine if we are in a Tauri environment
    const isTauri = typeof window !== 'undefined' && window.__TAURI__;
    const allowTauriApi = settings.allowTauriApi === true;
    const channelId = `sandbox-${Date.now()}`;
    const sandboxUrl = `./public/sandbox.html?channel=${channelId}`;

    if (!isTauri) {
      // Fallback: Browser-based iframe overlay for non-Tauri environments (Development)
      const overlay = document.createElement('div');
      overlay.className = 'sandbox-overlay';
      overlay.innerHTML = `
        <div class="sandbox-modal">
          <div class="sandbox-header">
            <span>AI Sandbox (Browser Fallback)</span>
            <span class="material-symbols-rounded close-sandbox">close</span>
          </div>
          <iframe class="sandbox-iframe" sandbox="allow-scripts" src="${sandboxUrl}"></iframe>
        </div>
      `;
      document.body.appendChild(overlay);

      const channel = new BroadcastChannel(channelId);
      const cleanup = () => {
        overlay.remove();
        channel.close();
      };

      overlay.querySelector('.close-sandbox').addEventListener('click', cleanup);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

      channel.onmessage = (event) => {
        const data = event.data;
        if (data.type === 'ready') {
          channel.postMessage({ action: 'execute', code, allowTauriApi: false });
        } else if (data.type === 'result') {
          if (data.status === 'success') showToast("代码执行完成", "success");
          else showToast(`执行出错: ${data.message}`, "error");
        }
      };
      return;
    }

    try {
      // Use Tauri WebviewWindow for a native separate window
      // Note: In Tauri v2 with withGlobalTauri:true, window.__TAURI__.window or window.__TAURI__.webviewWindow is used
      const tauri = window.__TAURI__;
      const WebviewWindow = (tauri.window && tauri.window.WebviewWindow) || 
                          (tauri.webviewWindow && tauri.webviewWindow.WebviewWindow);

      if (!WebviewWindow) {
        throw new Error("Tauri WebviewWindow API not found");
      }

      // Label choice: 'ai-sandbox-unsafe' if API is allowed, otherwise 'ai-sandbox-safe'
      // This allows us to target these labels in tauri.conf.json or capabilities
      const baseLabel = allowTauriApi ? 'ai-sandbox-unsafe' : 'ai-sandbox-safe';
      const uniqueLabel = `${baseLabel}-${Date.now()}`;

      const webview = new WebviewWindow(uniqueLabel, {
        url: sandboxUrl,
        title: `Sandbox${allowTauriApi ? ' (Tauri API Enabled)' : ''}`,
        width: 850,
        height: 650,
        center: true,
        decorations: true,
        alwaysOnTop: true,
        hiddenTitle: false,
        resizable: true,
        transparent: false
      });

      const channel = new BroadcastChannel(channelId);

      channel.onmessage = (event) => {
        const data = event.data;
        if (data.type === 'ready') {
          // Send execution payload to the new window
          channel.postMessage({ action: 'execute', code, allowTauriApi });
        } else if (data.type === 'result') {
          if (data.status === 'success') {
            showToast("沙盒运行成功", "success");
          } else {
            showToast(`沙盒运行出错: ${data.message}`, "error");
          }
          // We don't automatically close the window to let the user see logs
        } else if (data.type === 'console') {
          console.log(`[Sandbox ${data.method}]`, data.message);
        }
      };

      webview.once('tauri://error', (err) => {
        console.error('Failed to create sandbox window:', err);
        showToast("沙盒窗口创建失败", "error");
        channel.close();
      });

      // Optional: Cleanup channel when window is closed
      webview.once('tauri://destroyed', () => {
        channel.close();
      });

    } catch (error) {
      console.error('Error launching native sandbox:', error);
      showToast("执行失败", "error");
    }
  };

  const stopGeneration = async () => {
    if (window.__TAURI__ && currentStreamId) {
      try {
        await window.__TAURI__.core.invoke('cancel_stream', {
          streamId: currentStreamId
        });
      } catch (error) {
        console.error("Error cancelling stream:", error);
      }
    }
    if (abortController) {
      abortController.abort();
    }
    if (streamAnimationFrameId) {
      cancelAnimationFrame(streamAnimationFrameId);
      streamAnimationFrameId = null;
    }
    // Note: generatingSessionId is now cleared in handleSendMessage's finally block 
    // to ensure atomicity and prevent race conditions with incoming chunks.
  };

  // --- Updated Function: Input State Logic ---
  const updateInputState = () => {
    const isGeneratingCurrent = generatingSessionId === currentSessionId;

    const sendBtn = document.getElementById("send-message-button");
    const stopBtn = document.getElementById("stop-generation-btn");

    if (isGeneratingCurrent) {
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
    } else {
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';

      const hasContent = typingInput.value.trim().length > 0 || attachedFiles.length > 0;

      if (hasContent) {
        sendBtn.classList.add('enabled');
      } else {
        sendBtn.classList.remove('enabled');
      }

      if (generatingSessionId && generatingSessionId !== currentSessionId) {
      } else {
        typingInput.disabled = false;
      }
    }
  };

  // --- Modals and Toasts ---

  const showPromptEditor = (title, initialName = "", initialContent = "", callback) => {
    const modalPlaceholder = document.getElementById("custom-modal-placeholder");
    const existingModal = document.getElementById("custom-modal-overlay");
    if (existingModal) existingModal.remove();

    const overlay = document.createElement("div");
    overlay.id = "custom-modal-overlay";
    overlay.classList.add("prompt-editor-overlay");

    const content = document.createElement("div");
    content.classList.add("modal-content", "prompt-editor-modal");

    content.innerHTML = `
      <div class="prompt-editor-header">
        <h4>${DOMPurify.sanitize(title)}</h4>
      </div>
      <div class="prompt-editor-form">
        <div class="prompt-editor-input-group">
          <label class="prompt-editor-label">
            Name <span class="required">*</span>
          </label>
          <input type="text" class="prompt-editor-input glass-input" id="prompt-name-input" placeholder="Enter prompt name...">
        </div>
        <div class="prompt-editor-input-group">
          <label class="prompt-editor-label">
            Content <span class="required">*</span>
          </label>
          <textarea class="prompt-editor-textarea glass-input" id="prompt-content-input" placeholder="Enter prompt content..."></textarea>
          <div class="prompt-editor-char-count" id="char-count">0 characters</div>
        </div>
      </div>
      <div class="prompt-editor-footer">
        <button class="modal-cancel-btn glass-button">Cancel</button>
        <button class="modal-confirm-btn glass-button accent-button" id="save-prompt-btn">Save</button>
      </div>
    `;

    const nameInput = content.querySelector("#prompt-name-input");
    const contentInput = content.querySelector("#prompt-content-input");
    const charCount = content.querySelector("#char-count");
    const confirmBtn = content.querySelector("#save-prompt-btn");
    const cancelBtn = content.querySelector(".modal-cancel-btn");

    nameInput.value = initialName;
    contentInput.value = initialContent;
    charCount.textContent = `${initialContent.length} characters`;

    const updateCharCount = () => {
      charCount.textContent = `${contentInput.value.length} characters`;
    };

    const validate = () => {
      const nameValid = nameInput.value.trim().length > 0;
      const contentValid = contentInput.value.trim().length > 0;
      confirmBtn.disabled = !(nameValid && contentValid);
      confirmBtn.style.opacity = confirmBtn.disabled ? "0.5" : "1";
      confirmBtn.style.cursor = confirmBtn.disabled ? "not-allowed" : "pointer";
    };

    contentInput.addEventListener("input", () => {
      updateCharCount();
      validate();
    });

    nameInput.addEventListener("input", validate);

    overlay.appendChild(content);
    modalPlaceholder.appendChild(overlay);

    setTimeout(() => {
      overlay.classList.add("show");
      validate();
    }, 10);

    nameInput.focus();
    nameInput.select();

    let handleEsc;

    const closeModal = () => {
      overlay.classList.remove("show");
      overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
      document.removeEventListener("keydown", handleEsc);
    };

    handleEsc = (e) => {
      if (e.key === "Escape") {
        closeModal();
        if (callback) callback(null);
      }
    };
    document.addEventListener("keydown", handleEsc);

    confirmBtn.addEventListener("click", () => {
      const name = nameInput.value.trim();
      const promptContent = contentInput.value.trim();

      if (!name || !promptContent) {
        showToast("Name and content are required", "error");
        return;
      }

      if (callback) {
        callback({ name, content: promptContent });
      }
      closeModal();
    });

    cancelBtn.addEventListener("click", () => {
      closeModal();
      if (callback) callback(null);
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        closeModal();
        if (callback) callback(null);
      }
    });

    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        contentInput.focus();
      }
    });

    contentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        confirmBtn.click();
      }
    });
  };

  const createModal = (type, title, message, callback = null, defaultValue = "", isTextarea = false) => {
    const modalPlaceholder = document.getElementById("custom-modal-placeholder");
    const existingModal = document.getElementById("custom-modal-overlay");
    if (existingModal) existingModal.remove();

    const overlay = document.createElement("div");
    overlay.id = "custom-modal-overlay";
    const content = document.createElement("div");
    content.classList.add("modal-content");

    let inputHTML = '';
    if (type === 'prompt') {
      inputHTML = isTextarea
          ? `<textarea class="modal-input glass-input" rows="8" style="resize:vertical"></textarea>`
          : `<input type="text" class="modal-input glass-input">`;
    }

    content.innerHTML = `
        <h4>${DOMPurify.sanitize(title)}</h4>
        <p>${DOMPurify.sanitize(message)}</p>
        ${inputHTML}
        <div class="modal-buttons">
            ${type !== 'alert' ? '<button class="modal-cancel-btn">取消</button>' : ''}
            <button class="modal-confirm-btn">${type === 'alert' ? '确定' : '确认'}</button>
        </div>
    `;

    const input = content.querySelector(".modal-input");
    if (input) {
      input.value = defaultValue;
    }

    overlay.appendChild(content);
    modalPlaceholder.appendChild(overlay);

    setTimeout(() => overlay.classList.add("show"), 10);

    const confirmBtn = content.querySelector(".modal-confirm-btn");
    const cancelBtn = content.querySelector(".modal-cancel-btn");

    let handleEsc;

    const closeModal = () => {
      overlay.classList.remove("show");
      overlay.addEventListener("transitionend", () => overlay.remove(), {
        once: true
      });
      document.removeEventListener('keydown', handleEsc);
    };

    handleEsc = (e) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener('keydown', handleEsc);

    confirmBtn.addEventListener("click", () => {
      if (callback) {
        type === 'prompt' ? callback(input.value) : callback();
      }
      closeModal();
    });

    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", e => {
      if (e.target === overlay) closeModal();
    });
    if (input) {
      input.focus();
      if (!isTextarea) {
        input.select();
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (isTextarea ? e.ctrlKey : !e.shiftKey)) {
          e.preventDefault();
          confirmBtn.click();
        }
      });
    }
  };

  // --- Updated Function: Toast Logic ---
  const showToast = (message, type = "info", duration = 2500) => {
    const container = document.getElementById("toast-container") || (() => {
      const c = document.createElement("div");
      c.id = "toast-container";
      body.appendChild(c);
      return c;
    })();

    container.innerHTML = "";

    const toast = document.createElement("div");
    toast.classList.add("toast-message", type);
    toast.innerHTML = DOMPurify.sanitize(message);
    container.appendChild(toast);
    setTimeout(() => toast.classList.add("show"), 10);
    setTimeout(() => {
      toast.classList.remove("show");
      toast.addEventListener("transitionend", () => toast.remove(), {
        once: true
      });
    }, duration);
  };

  const showConfirm = (title, message, callback) => {
    createModal('confirm', title, message, callback);
  };

  const showPrompt = (title, defaultValue, callback, isTextarea = false) => {
    createModal('prompt', title, "", callback, defaultValue, isTextarea);
  };

  const applyCustomCSS = () => {
    let styleTag = document.getElementById('dynamic-custom-css');

    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'dynamic-custom-css';
      document.head.appendChild(styleTag);
    }

    styleTag.textContent = settings.customCSS;
  };

  const updateWindowTitle = () => {
    const defaultTitle = "Miscuay";
    const displayTitle = settings.windowTitle || defaultTitle;

    if (titlebarTitle) {
      titlebarTitle.textContent = displayTitle;
    }

    if (window.__TAURI__) {
      window.__TAURI__.window.getCurrentWindow().setTitle(displayTitle);
    }

    document.title = displayTitle;
  };

  const initSidebarResize = () => {
    const sidebar = document.querySelector('.sidebar');
    const toggleButton = document.getElementById('sidebar-toggle-button');
    if (!sidebar || !toggleButton) return;

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'sidebar-resize-handle';
    sidebar.appendChild(resizeHandle);

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    const MIN_WIDTH = 260;
    const MAX_WIDTH = 500;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      sidebar.classList.add('resizing');
      sidebar.style.transition = 'none';
      toggleButton.style.transition = 'none';
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const dx = e.clientX - startX;

      if (startWidth <= MIN_WIDTH && dx < -50) {
        isResizing = false;
        sidebar.classList.remove('resizing');
        sidebar.style.transition = '';
        toggleButton.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        toggleSidebar();
        (async () => {
          await saveSettings();
        })();
        return;
      }

      let newWidth = startWidth + dx;

      if (newWidth < MIN_WIDTH) {
        newWidth = MIN_WIDTH;
      }
      if (newWidth > MAX_WIDTH) {
        newWidth = MAX_WIDTH;
      }

      settings.sidebarWidth = newWidth;
      applySidebarWidth();
    });

    document.addEventListener('mouseup', (e) => {
      if (!isResizing) return;

      isResizing = false;
      sidebar.classList.remove('resizing');
      sidebar.style.transition = '';
      toggleButton.style.transition = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      const dx = e.clientX - startX;
      let newWidth = startWidth + dx;

      if (newWidth > MAX_WIDTH) {
        newWidth = MAX_WIDTH;
      }

      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        settings.sidebarWidth = newWidth;
      }

      applySidebarWidth();
      (async () => {
        await saveSettings();
      })();
    });
  };

  // --- Start App ---
  initialize();
});
