(function() {
    'use strict';

    let contextMenuTarget = null;
    let savedSelection = null;

    function isTauriEnvironment() {
        return typeof window !== 'undefined' && window.__TAURI__;
    }

    function getClipboardAPI() {
        if (isTauriEnvironment()) {
            return window.__TAURI__.clipboardManager;
        }
        return null;
    }

    function init() {
        bindEvents();
        if (isTauriEnvironment()) {
            window.__TAURI__.event.listen('menu-action', (event) => {
                const action = event.payload;
                handleAction(action);
            });
        }
    }

    function bindEvents() {
        document.addEventListener('contextmenu', handleContextMenu);
        document.addEventListener('keydown', handleKeyboard);
    }

    function handleContextMenu(e) {
        const target = e.target;
        const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
        const isTextDiv = target.classList.contains('text') || target.closest('.text');
        const isContentEditable = target.contentEditable === 'true' || target.closest('[contenteditable="true"]');

        const composedPath = e.composedPath ? e.composedPath() : [];
        const isCSSEditor = composedPath.some(el => el && el.id === 'custom-css-input-container');

        let actualTarget = target;
        let shouldShowMenu = isTextInput || isTextDiv || isContentEditable;

        if (isCSSEditor) {
            const textarea = composedPath.find(el => el && el.classList && el.classList.contains('pce-textarea'));
            if (textarea) {
                actualTarget = textarea;
                shouldShowMenu = true;
            }
        }

        if (shouldShowMenu) {
            e.preventDefault();
            contextMenuTarget = actualTarget;
            savedSelection = null;

            if (actualTarget.tagName === 'INPUT' || actualTarget.tagName === 'TEXTAREA') {
                try {
                    savedSelection = {
                        start: actualTarget.selectionStart || 0,
                        end: actualTarget.selectionEnd || 0
                    };
                } catch (err) {}
            } else {
                const selection = window.getSelection();
                if (selection.rangeCount > 0) {
                    savedSelection = selection.getRangeAt(0).cloneRange();
                }
            }
            showContextMenu(e);
        }
    }

    async function checkClipboardContent() {
        const clipboardAPI = getClipboardAPI();
        if (!clipboardAPI) return false;
        try {
            const text = await clipboardAPI.readText();
            return text && text.length > 0;
        } catch (error) {
            return false;
        }
    }

    async function showContextMenu(e) {
        if (!isTauriEnvironment()) return;

        const target = contextMenuTarget;
        if (!target) return;

        const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
        let hasSelection = false;
        if (isTextInput) {
            if (target.type === 'number') {
                hasSelection = window.getSelection().toString().length > 0;
            } else {
                hasSelection = savedSelection && savedSelection.start !== savedSelection.end;
            }
        } else {
            hasSelection = savedSelection && !savedSelection.collapsed;
        }

        const hasClipboardContent = await checkClipboardContent();
        const isInChatView = target.closest('.chat-view') !== null;

        let disableCut = false;
        let disableCopy = false;
        let disablePaste = false;

        if (target.tagName === 'INPUT') {
            const inputType = target.type;
            if (['range', 'number'].includes(inputType)) {
                disableCut = true;
                if (inputType === 'range') disableCopy = true;
                disablePaste = true;
            } else if (inputType === 'password') {
                disableCut = true;
                disableCopy = true;
            }
        }

        try {
            await window.__TAURI__.core.invoke('show_native_menu', {
                hasSelection,
                canCopy: !disableCopy,
                canCut: isTextInput && !disableCut,
                hasClipboard: hasClipboardContent,
                isInChat: isInChatView || disablePaste
            });
        } catch (err) {
            console.error('Failed to show native menu:', err);
        }
    }

    function handleAction(action) {
        switch (action) {
            case 'copy': copyText(); break;
            case 'paste': pasteText(); break;
            case 'cut': cutText(); break;
            case 'select_all': selectAllText(); break;
            case 'inspect': openDevTools(); break;
        }
    }

    async function openDevTools() {
        if (isTauriEnvironment()) {
            try {
                await window.__TAURI__.core.invoke('open_devtools');
            } catch (err) {
                console.error('Failed to open devtools:', err);
            }
        }
    }

    function selectAllText() {
        if (!contextMenuTarget) return;
        contextMenuTarget.focus();
        if (contextMenuTarget.tagName === 'INPUT' || contextMenuTarget.tagName === 'TEXTAREA') {
            contextMenuTarget.setSelectionRange(0, contextMenuTarget.value.length);
        } else {
            const range = document.createRange();
            range.selectNodeContents(contextMenuTarget);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    async function copyText() {
        const clipboardAPI = getClipboardAPI();
        if (!clipboardAPI || !contextMenuTarget) return;
        try {
            let textToCopy = '';
            if (contextMenuTarget.tagName === 'INPUT' || contextMenuTarget.tagName === 'TEXTAREA') {
                if (contextMenuTarget.type === 'number') {
                    textToCopy = window.getSelection().toString();
                } else {
                    const selection = savedSelection || { start: 0, end: 0 };
                    textToCopy = contextMenuTarget.value.substring(selection.start, selection.end);
                }
            } else {
                if (savedSelection) {
                    const selection = window.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(savedSelection.cloneRange());
                    textToCopy = selection.toString();
                } else {
                    textToCopy = contextMenuTarget.innerText || contextMenuTarget.textContent;
                }
            }
            if (textToCopy) await clipboardAPI.writeText(textToCopy);
        } catch (error) {
            console.error('Copy failed:', error);
        }
    }

    async function pasteText() {
        const clipboardAPI = getClipboardAPI();
        if (!clipboardAPI || !contextMenuTarget) return;
        try {
            contextMenuTarget.focus();
            const text = await clipboardAPI.readText();
            if (!text) return;

            if (contextMenuTarget.tagName === 'INPUT' && contextMenuTarget.type === 'number') {
                if (!/^[1-9]\d*$/.test(text.trim())) return;
            }

            if (contextMenuTarget.tagName === 'INPUT' || contextMenuTarget.tagName === 'TEXTAREA') {
                const selection = savedSelection || { start: 0, end: 0 };
                const start = selection.start;
                const end = selection.end;
                const value = contextMenuTarget.value;
                contextMenuTarget.value = value.substring(0, start) + text + value.substring(end);
                contextMenuTarget.selectionStart = contextMenuTarget.selectionEnd = start + text.length;
                contextMenuTarget.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                const selection = window.getSelection();
                if (savedSelection) {
                    selection.removeAllRanges();
                    selection.addRange(savedSelection.cloneRange());
                }
                const range = selection.getRangeAt(0);
                range.deleteContents();
                range.insertNode(document.createTextNode(text));
                range.collapse(false);
                contextMenuTarget.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } catch (error) {
            console.error('Paste failed:', error);
        }
    }

    async function cutText() {
        const clipboardAPI = getClipboardAPI();
        if (!clipboardAPI || !contextMenuTarget) return;
        try {
            if (contextMenuTarget.tagName === 'INPUT' || contextMenuTarget.tagName === 'TEXTAREA') {
                if (contextMenuTarget.type === 'number') return;
                contextMenuTarget.focus();
                const selection = savedSelection || { start: 0, end: 0 };
                const start = selection.start;
                const end = selection.end;
                if (start !== end) {
                    const text = contextMenuTarget.value.substring(start, end);
                    await clipboardAPI.writeText(text);
                    contextMenuTarget.value = contextMenuTarget.value.substring(0, start) + contextMenuTarget.value.substring(end);
                    contextMenuTarget.selectionStart = contextMenuTarget.selectionEnd = start;
                    contextMenuTarget.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        } catch (error) {
            console.error('Cut failed:', error);
        }
    }

    function handleKeyboard(e) {
        if (e.key === 'F5') {
            e.preventDefault();
            location.reload();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
