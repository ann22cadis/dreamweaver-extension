console.log('[DW] index.js loaded - v2.10');
import { eventSource, event_types, extension_prompt_types } from "../../../../script.js";
import { getContext } from "../../../st-context.js";

const extensionName = "dreamweaver-extension";
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}/`;
const LS_KEY = 'dw_v2_data';

let promptsData = {};
let customPromptsData = {};
let currentTargetChar = 'all';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTagName(el) {
    const nameSpan = $(el).find('.dw-custom-tag-name');
    if (nameSpan.length > 0) return nameSpan.text().trim();
    return $(el).contents().filter(function () { return this.nodeType === 3; }).text().trim();
}

function getChatId() {
    try {
        const ctx = getContext();
        if (!ctx) return null;
        return ctx.chatId || ctx.groupId || (ctx.characterId !== undefined ? String(ctx.characterId) : null);
    } catch { return null; }
}

function isGroupChat() {
    try {
        const ctx = getContext();
        return !!(ctx && ctx.groupId);
    } catch { return false; }
}

function lsLoad() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}

function lsSave(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { console.error('DW lsSave:', e); }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

async function loadPrompts() {
    try {
        const response = await fetch(`${extensionFolderPath}prompts.json`);
        promptsData = await response.json();
        console.log('[DW] Prompts loaded:', Object.keys(promptsData).length);
    } catch (error) {
        console.error('[DW] Failed to load prompts:', error);
    }
}

async function loadHTML() {
    if ($('#dreamweaver-modal').length === 0) {
        try {
            const response = await fetch(`${extensionFolderPath}template.html`);
            const html = await response.text();
            $('body').append(html);
            console.log('[DW] HTML template injected');
        } catch (error) {
            console.error('[DW] Failed to load HTML:', error);
        }
    }
}

function compilePromptString(tagNames, targetChar) {
    const categorized = {
        'sum-world': [], 'sum-genre': [], 'sum-style': [], 'sum-censor': [],
        'sum-au': [], 'sum-trope': [], 'sum-behavior': [], 'sum-fetish': [], 'sum-custom': []
    };

    tagNames.forEach(t => {
        if (customPromptsData[t]) {
            categorized['sum-custom'].push(`- ${customPromptsData[t]}`);
            return;
        }
        if (promptsData[t]) {
            const el = $(`.dw-tag`).filter(function () { return getTagName(this) === t; }).first();
            let typeClass = 'sum-genre';
            if (el.length) {
                if (el.hasClass('dw-world-tag')) typeClass = 'sum-world';
                else if (el.hasClass('dw-genre-tag')) typeClass = 'sum-genre';
                else if (el.hasClass('dw-behavior-tag')) typeClass = 'sum-behavior';
                else if (el.hasClass('dw-trope-tag')) typeClass = 'sum-trope';
                else if (el.hasClass('dw-style-tag')) typeClass = 'sum-style';
                else if (el.hasClass('dw-fetish-tag')) typeClass = 'sum-fetish';
                else if (el.hasClass('dw-censorship-tag')) typeClass = 'sum-censor';
                else if (el.hasClass('dw-custom-tag')) typeClass = 'sum-custom';
                else if (el.hasClass('dw-au-tag')) typeClass = 'sum-au';
            }
            categorized[typeClass].push(`- ${promptsData[t]}`);
        }
    });

    let fullString = '';
    ['sum-world', 'sum-genre', 'sum-style', 'sum-censor', 'sum-au', 'sum-trope', 'sum-behavior', 'sum-fetish', 'sum-custom'].forEach(cat => {
        if (categorized[cat].length > 0) fullString += categorized[cat].join('\n') + '\n';
    });

    if (fullString.trim().length === 0) return "";

    let intro = "This roleplay must strictly be characterized by the following instructions and themes:\n";
    if (targetChar && targetChar !== 'all') {
        intro = `These strict instructions and behavioral guidelines apply exclusively to the character ${targetChar}:\nThis roleplay must strictly be characterized by the following instructions and themes:\n`;
    }
    return `<dreamweaver>\n${intro}${fullString.trim()}\n</dreamweaver>`;
}

// ─── Core Prompt Injection ────────────────────────────────────────────────────

function sendPromptToCore() {
    try {
        console.log('[DW] sendPromptToCore invoked');
        const context = getContext();
        if (!context) { console.error('[DW] Critical: No context'); return; }

        const chatId = getChatId();
        if (!chatId) { console.warn('[DW] No chatId - skipping injection'); return; }

        const depthInput = document.getElementById('dw-depth-input');
        const depthValue = depthInput ? Math.max(0, parseInt(depthInput.value, 10) || 0) : 0;

        const allData = lsLoad();
        const chatData = allData[chatId] || { all: { enabled: true, tags: [] }, chars: {} };

        if (!$('#dw-power-toggle').hasClass('active')) {
            context.setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
            return;
        }

        let activeTags = [];
        if (chatData.all?.enabled && chatData.all?.tags) {
            activeTags.push(...chatData.all.tags);
        }

        const speakerName = context.name2 || null;
        if (speakerName && chatData.chars?.[speakerName]?.enabled && chatData.chars[speakerName].tags) {
            activeTags.push(...chatData.chars[speakerName].tags);
        }

        activeTags = [...new Set(activeTags)];

        if (activeTags.length === 0) {
            context.setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
            return;
        }

        const instructions = compilePromptString(activeTags, speakerName);
        if (!instructions) {
            context.setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
            console.log('[DW] Prompt empty - cleared');
            return;
        }

        context.setExtensionPrompt(extensionName, instructions, extension_prompt_types.IN_CHAT, depthValue);
        console.log('[DW] ✅ SUCCESS: Prompt injected at depth', depthValue);
    } catch (e) {
        console.error("[DW] sendPromptToCore Error:", e);
    }
}

// ─── Save / Load ──────────────────────────────────────────────────────────────

function saveState() {
    try {
        const chatId = getChatId();
        if (!chatId) return;
        const activeTags = [];
        $('.dw-tag.active').each(function () { activeTags.push(getTagName(this)); });
        const state = { enabled: $('#dw-power-toggle').hasClass('active'), tags: activeTags };
        const allData = lsLoad();
        if (!allData[chatId]) allData[chatId] = { lastTarget: 'all', all: { enabled: true, tags: [] }, chars: {} };
        allData[chatId].lastTarget = currentTargetChar;
        if (currentTargetChar === 'all') allData[chatId].all = state;
        else {
            if (!allData[chatId].chars) allData[chatId].chars = {};
            allData[chatId].chars[currentTargetChar] = state;
        }
        allData.__custom = customPromptsData;
        allData.__depth = document.getElementById('dw-depth-input')?.value || '0';
        lsSave(allData);
        updateSummaryUI();
    } catch (e) { console.error("[DW] saveState:", e); }
}

function loadState() {
    try {
        const chatId = getChatId();
        const allData = lsLoad();
        customPromptsData = allData.__custom || {};
        const depthInput = document.getElementById('dw-depth-input');
        if (depthInput && allData.__depth !== undefined) depthInput.value = allData.__depth;
        renderCustomTags();
        if (!chatId) return;
        const chatData = allData[chatId] || { lastTarget: 'all', all: { enabled: true, tags: [] }, chars: {} };
        currentTargetChar = chatData.lastTarget || 'all';
        const state = (currentTargetChar === 'all') ? (chatData.all || { enabled: true, tags: [] }) : (chatData.chars?.[currentTargetChar] || { enabled: true, tags: [] });
        $('.dw-tag').removeClass('active');
        (state.tags || []).forEach(t => { $('.dw-tag').filter(function () { return getTagName(this) === t; }).addClass('active'); });
        if (state.enabled) $('#dw-power-toggle').addClass('active');
        else $('#dw-power-toggle').removeClass('active');
        updateSummaryUI();
    } catch (e) { console.error("[DW] loadState:", e); }
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function renderCustomTags() {
    const container = $('#dw-custom-tags-container');
    container.empty();
    Object.keys(customPromptsData).forEach(name => { container.append(buildCustomTagEl(name)); });
    const chatId = getChatId();
    if (chatId) {
        const allData = lsLoad();
        const chatData = allData[chatId];
        if (chatData) {
            const state = (currentTargetChar === 'all') ? chatData.all : (chatData.chars?.[currentTargetChar]);
            if (state && state.tags) {
                state.tags.forEach(t => {
                    container.find('.dw-custom-tag').filter(function () { return getTagName(this) === t; }).addClass('active');
                });
            }
        }
    }
}

function buildCustomTagEl(name) {
    return $(`<div class="dw-tag dw-custom-tag dw-custom-item"><span class="dw-custom-tag-name">${name}</span><span class="dw-custom-actions"><i class="fa-solid fa-pen dw-custom-edit"></i><i class="fa-solid fa-trash dw-custom-delete"></i></span></div>`);
}

function updateSummaryUI() {
    const selectedUI = [];
    const processedTags = new Set();
    
    $('.dw-tag.active').each(function () {
        const txt = getTagName(this);
        if (!txt) return;
        processedTags.add(txt);
        
        let cls = '';
        if ($(this).hasClass('dw-world-tag')) cls = 'sum-world';
        else if ($(this).hasClass('dw-genre-tag')) cls = 'sum-genre';
        else if ($(this).hasClass('dw-behavior-tag')) cls = 'sum-behavior';
        else if ($(this).hasClass('dw-trope-tag')) cls = 'sum-trope';
        else if ($(this).hasClass('dw-style-tag')) cls = 'sum-style';
        else if ($(this).hasClass('dw-fetish-tag')) cls = 'sum-fetish';
        else if ($(this).hasClass('dw-censorship-tag')) cls = 'sum-censor';
        else if ($(this).hasClass('dw-custom-tag')) cls = 'sum-custom';
        else if ($(this).hasClass('dw-au-tag')) cls = 'sum-au';
        selectedUI.push({ text: txt, type: cls });
    });

    if (currentTargetChar !== 'all') {
        const chatId = getChatId();
        const allData = lsLoad();
        const chatData = allData[chatId] || { all: { enabled: true, tags: [] }, chars: {} };
        
        if (chatData.all?.enabled && chatData.all?.tags) {
            chatData.all.tags.forEach(t => {
                if (!processedTags.has(t)) {
                    const el = $(`.dw-tag`).filter(function() { return getTagName(this) === t; }).first();
        let cls = '';
        if (el.length) {
            if (el.hasClass('dw-world-tag')) cls = 'sum-world';
            else if (el.hasClass('dw-behavior-tag')) cls = 'sum-behavior';
            else if (el.hasClass('dw-trope-tag')) cls = 'sum-trope';
            else if (el.hasClass('dw-style-tag')) cls = 'sum-style';
            else if (el.hasClass('dw-fetish-tag')) cls = 'sum-fetish';
            else if (el.hasClass('dw-censorship-tag')) cls = 'sum-censor';
            else if (el.hasClass('dw-custom-tag')) cls = 'sum-custom';
            else if (el.hasClass('dw-au-tag')) cls = 'sum-au';
            else if (el.hasClass('dw-genre-tag')) cls = 'sum-genre';
        }
                    selectedUI.push({ text: t + ' (Global)', type: cls + ' sum-inherited' });
                    processedTags.add(t);
                }
            });
        }
    }

    const summaryContainer = $('#dw-selected-tags');
    if (selectedUI.length > 0) {
        summaryContainer.empty();
        selectedUI.forEach(tag => { 
            summaryContainer.append(`<span class="dw-summary-tag ${tag.type}">${tag.text}</span>`); 
        });
    } else { summaryContainer.text('Ничего не выбрано'); }
}

function populateCharacterDropdown() {
    const list = $('#dw-char-list');
    list.empty();
    try {
        const ctx = getContext();
        if (!ctx) return;
        const chatCharsMap = new Map();
        const chatId = getChatId();
        if (ctx.groupId) {
            const group = ctx.groups.find(x => String(x.id) === String(ctx.groupId));
            if (group) group.members.forEach(m => {
                const char = ctx.characters.find(c => c && c.avatar === m);
                if (char) chatCharsMap.set(char.name, `/characters/${char.avatar}`);
            });
        } else if (ctx.characterId !== undefined) {
            const char = ctx.characters[ctx.characterId];
            if (char) chatCharsMap.set(char.name, `/characters/${char.avatar}`);
        }
        if (chatCharsMap.size === 0) { $('#dw-char-btn').hide(); return; }
        if (!isGroupChat()) {
            const [name, url] = [...chatCharsMap.entries()][0];
            currentTargetChar = 'all'; updateCharBtn(name, url);
            $('#dw-char-btn').show().css('cursor', 'default');
            return;
        }
        $('#dw-char-btn').show().css('cursor', 'pointer');
        list.append(`<div class="dw-char-option" data-name="all" data-avatar=""><i class="fa-solid fa-globe"></i><span>Глобально</span></div>`);
        chatCharsMap.forEach((url, name) => {
            const img = (url && url !== 'undefined') ? `<img src="${url}" alt="">` : `<i class="fa-solid fa-user"></i>`;
            list.append(`<div class="dw-char-option" data-name="${name}" data-avatar="${url}">${img}<span>${name}</span></div>`);
        });
        let opt = list.find(`.dw-char-option[data-name="${currentTargetChar}"]`);
        if (opt.length === 0) opt = list.find('.dw-char-option[data-name="all"]');
        updateCharBtn(currentTargetChar, opt.data('avatar'));
    } catch (e) { console.error("[DW] Dropdown Error:", e); }
}

function updateCharBtn(name, url) {
    if (name === 'all') $('#dw-char-btn').html('<i class="fa-solid fa-globe"></i>');
    else if (url) $('#dw-char-btn').html(`<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;">`);
    else $('#dw-char-btn').html('<i class="fa-solid fa-user"></i>');
}

function createUI() {
    if ($("#extensionsMenu").length > 0 && $("#dw-menu-item-container").length === 0) {
        $("#extensionsMenu").append(`<div id="dw-menu-item-container" class="extension_container interactable" tabindex="0"><div id="dw-menu-item" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><div class="dw-icon-wrapper"><img src="${extensionFolderPath}img/icon.png" class="dw-menu-icon"></div><span>Dreamweaver</span></div></div>`);
    }
}

async function init() {
    console.log('[DW] init() START');
    await loadPrompts();
    await loadHTML();
    setInterval(createUI, 1000);
    loadState();
    populateCharacterDropdown();

    $(document).on("click", "#dw-menu-item", () => { loadState(); populateCharacterDropdown(); $('#dreamweaver-modal').fadeIn(200); });
    $(document).on("click", "#dw-close, #dreamweaver-modal, .dw-flex-center", (e) => { 
        if (e.target.id === 'dw-close' || e.target.id === 'dreamweaver-modal' || $(e.target).hasClass('dw-flex-center')) {
            const expanded = $('.dw-textarea-wrapper.expanded');
            if (expanded.length > 0) {
                expanded.removeClass('expanded');
                $('#dreamweaver-modal').removeClass('dw-has-expanded');
                $('#dw-custom-prompt-expand i').removeClass('fa-compress').addClass('fa-expand');
                return;
            }
            $('#dreamweaver-modal').fadeOut(200); $('#dw-char-list').fadeOut(100); 
        }
    });
    $(document).on('click', '#dw-char-btn', (e) => { if (isGroupChat()) { e.stopPropagation(); $('#dw-char-list').fadeToggle(100); } });
    $(document).on('click', '.dw-char-option', function(e) {
        e.stopPropagation();
        const newName = $(this).data('name');
        const avatarUrl = $(this).data('avatar');
        if (newName === currentTargetChar) { $('#dw-char-list').fadeOut(100); return; }

        // Update metadata in storage before loading the new state
        const chatId = getChatId();
        if (chatId) {
            const allData = lsLoad();
            if (!allData[chatId]) allData[chatId] = { all: { enabled: true, tags: [] }, chars: {} };
            allData[chatId].lastTarget = newName;
            lsSave(allData);
        }

        currentTargetChar = newName;
        updateCharBtn(currentTargetChar, avatarUrl);
        $('#dw-char-list').fadeOut(100);
        loadState();
    });
    $(document).on('click', (e) => { if (!$(e.target).closest('#dw-char-selector').length) $('#dw-char-list').fadeOut(100); });
    $(document).on('click', '#dw-power-toggle', function() { $(this).toggleClass('active'); saveState(); });
    $(document).on('click', '.dw-tag:not(.dw-custom-item)', function() { $(this).toggleClass('active'); saveState(); });
    $(document).on('click', '.dw-custom-tag-name', function(e) { e.stopPropagation(); $(this).closest('.dw-tag').toggleClass('active'); saveState(); });
    $(document).on('click', '.dw-custom-delete', function(e) { 
        e.stopPropagation(); 
        const n = $(this).closest('.dw-tag').find('.dw-custom-tag-name').text().trim(); 
        if (confirm(`Вы уверены, что хотите удалить тег "${n}"?`)) {
            delete customPromptsData[n]; 
            $(this).closest('.dw-tag').remove(); 
            saveState(); 
        }
    });
    $(document).on('click', '.dw-custom-edit', function(e) { e.stopPropagation(); const n = $(this).closest('.dw-tag').find('.dw-custom-tag-name').text().trim(); $('#dw-custom-name').val(n); $('#dw-custom-prompt').val(customPromptsData[n]); delete customPromptsData[n]; $(this).closest('.dw-tag').remove(); saveState(); });
    $(document).on('input', '#dw-depth-input', saveState);
    $(document).on('click', '#dw-info-toggle', function() { $('#dreamweaver-modal').toggleClass('show-descriptions'); $(this).toggleClass('active'); });
    $(document).on('click', '#dw-custom-prompt-expand', function() {
        const wrapper = $(this).closest('.dw-textarea-wrapper');
        const isExpanded = wrapper.toggleClass('expanded').hasClass('expanded');
        $('#dreamweaver-modal').toggleClass('dw-has-expanded', isExpanded);
        $(this).find('i').toggleClass('fa-expand fa-compress');
        if (isExpanded) {
            setTimeout(() => wrapper.find('textarea').focus(), 100);
        }
    });
    $(document).on('click', '.dw-summary-tag', function() { const txt = $(this).text(); $('.dw-tag').filter(function(){return getTagName(this)===txt;}).removeClass('active'); saveState(); });
    $(document).on('click', '.dw-cat-title', function() { $(this).next('.dw-cat-content').slideToggle(200); $(this).find('.dw-chevron').toggleClass('fa-chevron-down fa-chevron-up'); });
    $(document).on('click', '.dw-sub-title', function() { $(this).next('.dw-sub-content').slideToggle(200); $(this).find('.dw-chevron-sub').toggleClass('fa-chevron-down fa-chevron-up'); });
    $(document).on('click', '#dw-custom-add', () => {
        const n = $('#dw-custom-name').val().trim(), p = $('#dw-custom-prompt').val().trim();
        if (n && p) { customPromptsData[n] = p; const el = buildCustomTagEl(n); el.addClass('active'); $('#dw-custom-tags-container').append(el); $('#dw-custom-name').val(''); $('#dw-custom-prompt').val(''); saveState(); }
    });
    console.log('[DW] init() DONE');
}

// ─── Events ───────────────────────────────────────────────────────────────────

console.log('[DW] Registering listeners...');

// Primary Event
eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => {
    console.log('[DW] EVENT: GENERATION_AFTER_COMMANDS');
    sendPromptToCore();
});

// Fail-safe 1: Right before combine (Standard for newer ST)
eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, () => {
    console.log('[DW] EVENT FAILSAFE: GENERATE_BEFORE_COMBINE_PROMPTS');
    sendPromptToCore();
});

// Fail-safe 2: Generation started
eventSource.on(event_types.GENERATION_STARTED, () => {
    console.log('[DW] EVENT FAILSAFE: GENERATION_STARTED');
    sendPromptToCore();
});

// Fallback 2: Setting update (triggered by click Send sometimes)
eventSource.on(event_types.SETTINGS_UPDATED, () => {
    // Only check if we are in target chat
    console.log('[DW] EVENT FALLBACK: SETTINGS_UPDATED');
    // sendPromptToCore(); // might be too aggressive, but let's see
});

eventSource.on(event_types.CHAT_CHANGED, () => {
    console.log('[DW] EVENT: CHAT_CHANGED');
    loadState();
    populateCharacterDropdown();
});

// Start
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    $(document).ready(init);
}
