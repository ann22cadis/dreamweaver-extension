console.log('[DW] index.js loaded - v2.11');
import { eventSource, event_types, extension_prompt_types } from "../../../../script.js";
import { getContext } from "../../../st-context.js";

const extensionName = "dreamweaver-extension";
const META_KEY = 'dreamweaver'; // key inside chat metadata; must stay constant so exported chats keep their tags
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}/`;
const LS_KEY = 'dw_v2_data';

let promptsData = {};
let customPromptsData = {};
let customNegative = new Set(); // names of custom tags that are prohibitions rather than rules
let currentTargetChar = 'all';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTagName(el) {
    const nameSpan = $(el).find('.dw-custom-tag-name');
    if (nameSpan.length > 0) return nameSpan.text().trim();
    return $(el).contents().filter(function () { return this.nodeType === 3; }).text().trim();
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// Per-chat state lives in chat metadata (saved inside the chat file, so it survives export/import).
// localStorage is kept for global data (custom tags, depth) and as a read-only fallback for old chats.

function emptyChatData() {
    return { lastTarget: 'all', all: { enabled: true, tags: [] }, chars: {} };
}

function getChatData(chatId) {
    try {
        const meta = getContext()?.chatMetadata?.[META_KEY];
        if (meta?.data) return meta.data;
    } catch { /* fall through to legacy storage */ }
    return lsLoad()[chatId] || emptyChatData();
}

function setChatData(chatData) {
    const ctx = getContext();
    if (!ctx?.chatMetadata) return;
    // Embed the prompt text of used custom tags so they still work on a device that doesn't have them.
    const used = new Set([...(chatData.all?.tags || []), ...Object.values(chatData.chars || {}).flatMap(s => s.tags || [])]);
    const custom = {};
    used.forEach(t => { if (customPromptsData[t]) custom[t] = customPromptsData[t]; });
    const customNeg = Object.keys(custom).filter(t => customNegative.has(t));
    ctx.chatMetadata[META_KEY] = { data: chatData, custom, customNeg };
    ctx.saveMetadataDebounced();
}

// Chats set up before v2.11 keep their state only in localStorage; copy it into the chat file
// on open so it travels with exports without the user having to re-click a tag.
function migrateLegacyChatData(chatId) {
    const ctx = getContext();
    if (!ctx?.chatId || !ctx.chatMetadata || ctx.chatMetadata[META_KEY]?.data) return;
    const legacy = lsLoad()[chatId];
    if (legacy) setChatData(legacy);
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

// Tag element class → summary/prompt category. Order here is also the order in the compiled prompt.
const TAG_TYPES = [
    ['dw-world-tag', 'sum-world'],
    ['dw-genre-tag', 'sum-genre'],
    ['dw-style-tag', 'sum-style'],
    ['dw-censorship-tag', 'sum-censor'],
    ['dw-au-tag', 'sum-au'],
    ['dw-trope-tag', 'sum-trope'],
    ['dw-behavior-tag', 'sum-behavior'],
    ['dw-fetish-tag', 'sum-fetish'],
    // Before dw-custom-tag: a custom prohibition carries both classes and must count as negative.
    ['dw-negative-tag', 'sum-negative'],
    ['dw-custom-tag', 'sum-custom'],
];

function getTagType(el) {
    const $el = $(el);
    for (const [tagClass, sumClass] of TAG_TYPES) {
        if ($el.hasClass(tagClass)) return sumClass;
    }
    return '';
}

function findTagEl(name) {
    return $('.dw-tag').filter(function () { return getTagName(this) === name; }).first();
}

// Prompt strength levels (slider 1–4). Each level sets the wording, how often the rules are sent,
// and the depth the slider puts into the "Глубина" field (the user can still change it by hand).
// Prohibitions are sent on every reply at every level: skipping them lets banned words back in.
const STRENGTH_LEVELS = {
    1: {
        name: 'Фон', hint: 'мягко, правила раз в 3 ответа, запреты всегда', depth: 6, every: 3,
        positive: 'Let the following themes and instructions gently shape the roleplay in the background. Apply them subtly and only where they fit naturally; never showcase them or repeat the same devices from reply to reply:',
        negative: 'Avoid the following:',
    },
    2: {
        name: 'Обычно', hint: 'естественно, без выпячивания', depth: 4, every: 1,
        positive: 'This roleplay is characterized by the following instructions and themes. Follow them naturally, without calling attention to them or repeating the same devices in every reply:',
        negative: 'Do not do or write any of the following:',
    },
    3: {
        name: 'Сильно', hint: 'строго, каждый ответ', depth: 2, every: 1,
        positive: 'This roleplay must strictly be characterized by the following instructions and themes:',
        negative: 'STRICT PROHIBITIONS. Never do or write any of the following, under any circumstances:',
    },
    4: {
        name: 'Жёстко', hint: 'максимально, у самого конца чата', depth: 0, every: 1,
        positive: 'MANDATORY RULES. You MUST follow every instruction below in every reply, without exception:',
        negative: 'ABSOLUTE PROHIBITIONS. NEVER do or write any of the following under ANY circumstances; violating them is unacceptable:',
    },
};
const DEFAULT_STRENGTH = 3; // matches the wording used before the slider existed

function getStrength() {
    const v = parseInt($('#dw-strength-input').val(), 10);
    return STRENGTH_LEVELS[v] ? v : DEFAULT_STRENGTH;
}

function updateStrengthLabel() {
    const lvl = STRENGTH_LEVELS[getStrength()];
    $('#dw-strength-name').text(lvl.name);
    $('#dw-strength-hint').text(lvl.hint);
}

// Count of character replies so far; used to send the rules only every N-th reply on low strength.
function getReplyCount(context) {
    return (context.chat || []).filter(m => m && !m.is_user && !m.is_system).length;
}

// ─── Smart prohibitions ──────────────────────────────────────────────────────
// Prohibitions that can be checked in text. With "smart bans" on, such a tag is sent only when its
// words actually showed up in the last replies, and then only the words that were found, not the
// whole list (listing banned words makes the model more likely to use them).
// Prohibitions about behavior (moralizing, speaking for {{user}}...) can't be detected: always sent.
// In patterns: "~" = rest of a word (any letters), "_" = whitespace. JS \w and \b don't know Cyrillic.
const SMART_WINDOW = 6; // how many recent character replies are scanned

const DETECTOR_SOURCES = {
    'No Russian AI Slop': [
        // a literal ship's anchor ("бросил якорь", "на якоре") is allowed by the prompt, so skip it here
        '(?<!(?:брос|подн[яи]|отда|сн[яи]|выбра)~_)(?<!(?:на|с|со)_)якор[ьяеюи]~', 'маяк(?:а|у|ом|е|и|ов|ам|ами|ах)?', 'спасательн~_круг~', 'озон~', 'мускус~', 'сандал(?![иья])~', 'спес[ьиюя]~',
        'хищн~', 'добыч~', 'зверь_внутри', 'первобытн~', 'собственническ~', 'властн~', 'прорычал~', 'рыкнул~',
        'мурлык~', 'мурлыч~', '(?:металлическ|медн)~_(?:привкус|послевкус)~', 'стал[ьи]_в_голосе',
        '(?:густ|тяж[её]л|плотн|наэлектризованн)~_воздух~', 'воздух~_(?:был|стал)~_(?:густ|тяж[её]л|плотн|наэлектризованн)~',
        'мурашк~', 'пропустил~_удар', 'побелевш~_костяшк~', 'костяшк~_(?:пальцев_)?побелел~',
        'глаза_потемнел~', 'потемневш~_глаз~', 'маска_(?:треснула|слетела|дала_трещину)',
        'что-то_(?:внутри_)?(?:оборвал|щ[её]лкнул|сломал|треснул)~', 'мир_сузился', 'время_(?:остановилось|замедлилось|замерло)',
        'точк~_невозврата', 'последн~_капл~', 'уголо?к~_губ', 'бровь_(?:поползла|приподнялась|изогнулась)',
        '(?:пробуя|пробовал~|смаковал~)[^.!?\\n]{0,25}на_вкус', 'смаковал~_(?:имя|слово)', 'капитуляц~', 'заяв~_(?:свои_)?права',
    ],
    'No GPT-isms': [
        'shivers?_(?:ran_)?down_(?:my|his|her|their|your)_spine', 'barely_above_a_whisper', 'sparkl~_with_mischief',
        'ministrations', 'testament_to', 'tapestry', 'little_did_(?:he|she|they|i|we)_know', 'the_air_(?:was_)?thick_with', 'a_dance_of',
    ],
    'No English Calques': [
        'это_имеет_смысл', 'ты_в_порядке', 'вы_в_порядке', 'окей', 'вау', 'детк~', 'сделал~_паузу', 'я_здесь_для_тебя',
        'дай(?:те)?_мне_знать', 'сделать_разницу', 'о_боже',
    ],
    'No Russian Cultural References': [
        'партизан~', 'декабрист~', 'сусанин~', 'штирлиц~', 'чапаев~', 'крепостничеств~',
        'крепостн~_(?:крестьян|прав|девк|мужик|душ)~', 'колхоз~', 'субботник~', 'самовар~',
        'авоськ~', 'рубл(?:ь|я|ей|ю|ём|ем|ями|ях)', 'копе(?:йк|ек)~', 'в[её]рст(?:а|ы|у|ой|е|ами|ах)?', 'аршин~',
    ],
};

// Non-word patterns, used as-is.
const DETECTOR_RAW = {
    'No Em Dashes': [/—/gu],
    'No Emojis': [/\p{Extended_Pictographic}/gu],
    'No Asterisks': [/\*[^*\n]{1,200}\*/gu],
};

const DETECTORS = (() => {
    const out = {};
    for (const [tag, list] of Object.entries(DETECTOR_SOURCES)) {
        out[tag] = list.map(src => new RegExp(
            '(?<!\\p{L})(?:' + src.replace(/~/g, '\\p{L}*').replace(/_/g, '\\s+') + ')(?!\\p{L})', 'giu'));
    }
    return Object.assign(out, DETECTOR_RAW);
})();

function isSmartBansOn() {
    return $('#dw-smart-bans').is(':checked');
}

function getRecentReplies(context) {
    return (context?.chat || []).filter(m => m && !m.is_user && !m.is_system && m.mes).slice(-SMART_WINDOW).map(m => m.mes);
}

// Words/phrases of a detectable prohibition found in recent replies (unique, at most 8).
function detectViolations(tag, texts) {
    const found = new Set();
    for (const re of DETECTORS[tag] || []) {
        for (const text of texts) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text)) && found.size < 8) {
                found.add(m[0].replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40));
                if (re.lastIndex === m.index) re.lastIndex++;
            }
        }
    }
    return [...found];
}

function targetedProhibition(tag, words) {
    const label = (promptsData[tag]?.match(/^Prohibited: '([^']+)'/) || [])[1] || tag;
    return `- Prohibited: '${label}'. In recent replies you used: ${words.map(w => `«${w}»`).join(', ')}. ` +
        'Never use these again, in any form, and do not swap them for synonyms of the same cliché; describe the moment plainly and specifically instead.';
}

function compilePromptString(tagNames, targetChar, { strength = DEFAULT_STRENGTH, includePositive = true, recentTexts = null } = {}) {
    const level = STRENGTH_LEVELS[strength] || STRENGTH_LEVELS[DEFAULT_STRENGTH];
    const categorized = Object.fromEntries(TAG_TYPES.map(([, sum]) => [sum, []]));

    tagNames.forEach(t => {
        if (customPromptsData[t]) {
            categorized[customNegative.has(t) ? 'sum-negative' : 'sum-custom'].push(`- ${customPromptsData[t]}`);
            return;
        }
        if (promptsData[t]) {
            const typeClass = getTagType(findTagEl(t)) || 'sum-genre';
            // Smart bans: a detectable prohibition is sent only for words actually seen recently.
            if (typeClass === 'sum-negative' && recentTexts && DETECTORS[t]) {
                const words = detectViolations(t, recentTexts);
                if (words.length) categorized[typeClass].push(targetedProhibition(t, words));
                return;
            }
            categorized[typeClass].push(`- ${promptsData[t]}`);
        }
    });

    // Positive instructions first, prohibitions in their own block so the model reads them as hard limits.
    let fullString = '';
    if (includePositive) {
        TAG_TYPES.forEach(([, cat]) => {
            if (cat !== 'sum-negative' && categorized[cat].length > 0) fullString += categorized[cat].join('\n') + '\n';
        });
    }
    const negatives = categorized['sum-negative'];

    if (fullString.trim().length === 0 && negatives.length === 0) return "";

    let intro = '';
    if (targetChar && targetChar !== 'all') {
        intro = `These instructions and behavioral guidelines apply exclusively to the character ${targetChar}:\n`;
    }
    let body = '';
    if (fullString.trim()) {
        body += `${level.positive}\n${fullString.trim()}\n`;
    }
    if (negatives.length) {
        if (body) body += '\n';
        body += `${level.negative}\n${negatives.join('\n')}\n`;
    }
    return `<dreamweaver>\n${intro}${body.trim()}\n</dreamweaver>`;
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

        const chatData = getChatData(chatId);

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

        const strength = getStrength();
        const every = STRENGTH_LEVELS[strength].every;
        // On low strength the rules ride along only every N-th reply (prohibitions always do).
        const includePositive = every <= 1 || getReplyCount(context) % every === 0;
        const recentTexts = isSmartBansOn() ? getRecentReplies(context) : null;
        const instructions = compilePromptString(activeTags, speakerName, { strength, includePositive, recentTexts });
        if (!instructions) {
            context.setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
            console.log('[DW] Prompt empty - cleared');
            return;
        }

        context.setExtensionPrompt(extensionName, instructions, extension_prompt_types.IN_CHAT, depthValue);
        console.log('[DW] ✅ SUCCESS: Prompt injected at depth', depthValue, 'strength', strength, includePositive ? '' : '(prohibitions only this turn)');
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
        const chatData = getChatData(chatId);
        chatData.lastTarget = currentTargetChar;
        if (currentTargetChar === 'all') chatData.all = state;
        else {
            if (!chatData.chars) chatData.chars = {};
            chatData.chars[currentTargetChar] = state;
        }
        const allData = lsLoad();
        allData.__custom = customPromptsData;
        allData.__customNeg = [...customNegative].filter(n => n in customPromptsData);
        allData.__depth = document.getElementById('dw-depth-input')?.value || '0';
        allData.__strength = getStrength();
        allData.__smartBans = isSmartBansOn();
        lsSave(allData);
        setChatData(chatData);
        updateSummaryUI();
    } catch (e) { console.error("[DW] saveState:", e); }
}

function loadState() {
    try {
        const chatId = getChatId();
        const allData = lsLoad();
        customPromptsData = allData.__custom || {};
        customNegative = new Set(allData.__customNeg || []);
        // Custom tags embedded in an imported chat: add the ones this device doesn't have yet.
        const meta = getContext()?.chatMetadata?.[META_KEY];
        const embedded = meta?.custom;
        if (embedded) {
            const embeddedNeg = new Set(meta.customNeg || []);
            let added = false;
            for (const [name, prompt] of Object.entries(embedded)) {
                if (!(name in customPromptsData)) {
                    customPromptsData[name] = prompt;
                    if (embeddedNeg.has(name)) customNegative.add(name);
                    added = true;
                }
            }
            if (added) { allData.__custom = customPromptsData; allData.__customNeg = [...customNegative]; lsSave(allData); }
        }
        const depthInput = document.getElementById('dw-depth-input');
        if (depthInput && allData.__depth !== undefined) depthInput.value = allData.__depth;
        // Existing users have no saved strength: keep the old wording (level 3) and don't touch their depth.
        $('#dw-strength-input').val(STRENGTH_LEVELS[allData.__strength] ? allData.__strength : DEFAULT_STRENGTH);
        updateStrengthLabel();
        $('#dw-smart-bans').prop('checked', !!allData.__smartBans);
        if (chatId) migrateLegacyChatData(chatId);
        renderCustomTags();
        if (!chatId) {
            // No chat open: don't keep showing the previous chat's selection.
            $('.dw-tag').removeClass('active');
            updateSummaryUI();
            return;
        }
        const chatData = getChatData(chatId);
        currentTargetChar = chatData.lastTarget || 'all';
        applyTargetState(chatData);
    } catch (e) { console.error("[DW] loadState:", e); }
}

// Re-apply tag selection for currentTargetChar without re-reading lastTarget.
function loadStateForTarget() {
    try {
        const chatId = getChatId();
        if (!chatId) return;
        applyTargetState(getChatData(chatId));
    } catch (e) { console.error("[DW] loadStateForTarget:", e); }
}

function applyTargetState(chatData) {
    const state = (currentTargetChar === 'all') ? (chatData.all || { enabled: true, tags: [] }) : (chatData.chars?.[currentTargetChar] || { enabled: true, tags: [] });
    $('.dw-tag').removeClass('active');
    (state.tags || []).forEach(t => { $('.dw-tag').filter(function () { return getTagName(this) === t; }).addClass('active'); });
    $('#dw-power-toggle').toggleClass('active', state.enabled !== false);
    updateSummaryUI();
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function renderCustomTags() {
    const container = $('#dw-custom-tags-container');
    container.empty();
    Object.keys(customPromptsData).forEach(name => { container.append(buildCustomTagEl(name)); });
    const chatId = getChatId();
    if (chatId) {
        const chatData = getChatData(chatId);
        {
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
    const neg = customNegative.has(name);
    return $(`<div class="dw-tag dw-custom-tag dw-custom-item${neg ? ' dw-negative-tag' : ''}"${neg ? ' title="Запрет"' : ''}>${neg ? '<i class="fa-solid fa-ban dw-custom-kind-icon"></i>' : ''}<span class="dw-custom-tag-name">${escapeHtml(name)}</span><span class="dw-custom-actions"><i class="fa-solid fa-pen dw-custom-edit"></i><i class="fa-solid fa-trash dw-custom-delete"></i></span></div>`);
}

// Kind switch in the custom tag form: 'rule' (regular instruction) or 'negative' (prohibition).
function getCustomKind() {
    return $('.dw-kind-btn.active').attr('data-kind') === 'negative' ? 'negative' : 'rule';
}

function setCustomKind(kind) {
    const k = kind === 'negative' ? 'negative' : 'rule';
    $('.dw-kind-btn').each(function () { $(this).toggleClass('active', $(this).attr('data-kind') === k); });
    $('#dw-custom-prompt').attr('placeholder', k === 'negative'
        ? 'Что ИИ нельзя делать или писать (например: Never mention the weather)...'
        : 'Текст промпта (правило для ИИ)...');
}

function updateSummaryUI() {
    const selectedUI = [];
    const processedTags = new Set();
    
    $('.dw-tag.active').each(function () {
        const txt = getTagName(this);
        if (!txt) return;
        processedTags.add(txt);
        selectedUI.push({ text: txt, type: getTagType(this) });
    });

    if (currentTargetChar !== 'all') {
        const chatId = getChatId();
        const chatData = getChatData(chatId);

        if (chatData.all?.enabled && chatData.all?.tags) {
            chatData.all.tags.forEach(t => {
                if (!processedTags.has(t)) {
                    const cls = getTagType(findTagEl(t));
                    selectedUI.push({ text: t + ' (Global)', tag: t, type: cls + ' sum-inherited', inherited: true });
                    processedTags.add(t);
                }
            });
        }
    }

    const summaryContainer = $('#dw-selected-tags');
    let recentTexts = null;
    if (isSmartBansOn()) {
        try { recentTexts = getRecentReplies(getContext()); } catch { recentTexts = null; }
    }
    if (selectedUI.length > 0) {
        summaryContainer.empty();
        selectedUI.forEach(tag => {
            const el = $(`<span class="dw-summary-tag ${tag.type}"></span>`).text(tag.text).attr('data-tag', tag.tag ?? tag.text);
            if (tag.inherited) el.attr('title', 'Глобальный тег — снимается в режиме «Глобально»');
            // Smart bans: show whether a detectable prohibition is currently sent or waiting.
            const name = tag.tag ?? tag.text;
            if (recentTexts && DETECTORS[name] && el.hasClass('sum-negative') && !customPromptsData[name]) {
                const words = detectViolations(name, recentTexts);
                if (words.length) el.attr('title', `Замечено в последних ответах: ${words.join(', ')}. Запрет отправляется.`);
                else el.addClass('sum-sleeping').attr('title', `Ждёт: в последних ${SMART_WINDOW} ответах не встречалось, поэтому не отправляется.`);
            }
            summaryContainer.append(el);
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
            if (currentTargetChar !== 'all') { currentTargetChar = 'all'; loadStateForTarget(); }
            updateCharBtn(name, url);
            $('#dw-char-btn').show().css('cursor', 'default');
            return;
        }
        $('#dw-char-btn').show().css('cursor', 'pointer');
        list.append(`<div class="dw-char-option" data-name="all" data-avatar=""><i class="fa-solid fa-globe"></i><span>Глобально</span></div>`);
        chatCharsMap.forEach((url, name) => {
            const img = (url && url !== 'undefined') ? `<img src="${escapeHtml(url)}" alt="">` : `<i class="fa-solid fa-user"></i>`;
            list.append(`<div class="dw-char-option" data-name="${escapeHtml(name)}" data-avatar="${escapeHtml(url)}">${img}<span>${escapeHtml(name)}</span></div>`);
        });
        // Match by attribute value, not a CSS selector: names with quotes would break the selector.
        let opt = list.find('.dw-char-option').filter(function () { return $(this).attr('data-name') === currentTargetChar; });
        if (opt.length === 0) {
            // Saved target is no longer in this group: fall back to global and show its state.
            opt = list.find('.dw-char-option[data-name="all"]');
            if (currentTargetChar !== 'all') { currentTargetChar = 'all'; loadStateForTarget(); }
        }
        updateCharBtn(currentTargetChar, opt.attr('data-avatar'));
    } catch (e) { console.error("[DW] Dropdown Error:", e); }
}

function updateCharBtn(name, url) {
    if (name === 'all') $('#dw-char-btn').html('<i class="fa-solid fa-globe"></i>');
    else if (url) $('#dw-char-btn').html(`<img src="${escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;">`);
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

    const collapseExpanded = () => {
        const expanded = $('.dw-textarea-wrapper.expanded');
        if (expanded.length === 0) return false;
        expanded.removeClass('expanded');
        $('#dreamweaver-modal').removeClass('dw-has-expanded');
        $('#dw-custom-prompt-expand i').removeClass('fa-compress').addClass('fa-expand');
        return true;
    };
    const closeCharList = () => { const l = $('#dw-char-list'); if (l.is(':visible')) l.stop(true, true).fadeOut(100); };
    const openModal = () => {
        loadState();
        populateCharacterDropdown();
        $('#dw-char-list').stop(true, true).hide();
        $('#dreamweaver-modal').stop(true, true).fadeIn(200);
    };
    const closeModal = () => {
        if (collapseExpanded()) return;
        closeCharList();
        $('#dreamweaver-modal').stop(true, true).fadeOut(200);
    };

    $(document).on('click', '#dw-menu-item', openModal);
    $(document).on('keydown', '#dw-menu-item-container, #dw-menu-item', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openModal(); }
    });

    // Close on backdrop only when the press also started on the backdrop; otherwise selecting
    // text in an input and releasing outside the window would close the modal.
    let backdropPress = false;
    const isBackdrop = (el) => el.id === 'dreamweaver-modal' || $(el).hasClass('dw-flex-center');
    $(document).on('mousedown touchstart', '#dreamweaver-modal', (e) => { backdropPress = isBackdrop(e.target); });
    $(document).on('click', '#dw-close', (e) => { e.stopPropagation(); closeModal(); });
    $(document).on('click', '#dreamweaver-modal', (e) => {
        if (isBackdrop(e.target) && backdropPress) closeModal();
        backdropPress = false;
    });
    $(document).on('keydown', (e) => {
        if (e.key !== 'Escape' || !$('#dreamweaver-modal').is(':visible')) return;
        e.preventDefault();
        e.stopPropagation();
        if ($('#dw-char-list').is(':visible')) closeCharList();
        else closeModal();
    });

    $(document).on('click', '#dw-char-btn', (e) => { if (isGroupChat()) { e.stopPropagation(); $('#dw-char-list').stop(true, true).fadeToggle(100); } });
    $(document).on('click', '.dw-char-option', function(e) {
        e.stopPropagation();
        // attr() instead of data(): data() turns names like "123" into numbers.
        const newName = $(this).attr('data-name');
        const avatarUrl = $(this).attr('data-avatar');
        if (newName === currentTargetChar) { $('#dw-char-list').fadeOut(100); return; }

        // Update metadata in storage before loading the new state
        const chatId = getChatId();
        if (chatId) {
            const chatData = getChatData(chatId);
            chatData.lastTarget = newName;
            setChatData(chatData);
        }

        currentTargetChar = newName;
        updateCharBtn(currentTargetChar, avatarUrl);
        $('#dw-char-list').fadeOut(100);
        loadState();
    });
    $(document).on('click', (e) => { if (!$(e.target).closest('#dw-char-selector').length) closeCharList(); });
    $(document).on('click', '#dw-power-toggle', function() { $(this).toggleClass('active'); saveState(); });
    $(document).on('click', '.dw-tag:not(.dw-custom-item)', function() { $(this).toggleClass('active'); saveState(); });
    $(document).on('click', '.dw-custom-tag-name', function(e) { e.stopPropagation(); $(this).closest('.dw-tag').toggleClass('active'); saveState(); });
    $(document).on('click', '.dw-custom-delete', function(e) { 
        e.stopPropagation(); 
        const n = $(this).closest('.dw-tag').find('.dw-custom-tag-name').text().trim(); 
        if (confirm(`Вы уверены, что хотите удалить тег "${n}"?`)) {
            delete customPromptsData[n];
            customNegative.delete(n);
            $(this).closest('.dw-tag').remove();
            saveState(); 
        }
    });
    $(document).on('click', '.dw-custom-edit', function(e) { e.stopPropagation(); const tagEl = $(this).closest('.dw-tag'); const n = tagEl.find('.dw-custom-tag-name').text().trim(); const isActive = tagEl.hasClass('active'); $('#dw-custom-name').val(n).data('editing', n).data('was-active', isActive); $('#dw-custom-prompt').val(customPromptsData[n]); setCustomKind(customNegative.has(n) ? 'negative' : 'rule'); $('#dw-custom-add').text('Сохранить'); });
    $(document).on('click', '.dw-kind-btn', function() { setCustomKind($(this).attr('data-kind')); });
    $(document).on('input', '#dw-depth-input', saveState);
    // Moving the slider also sets the level's depth; the depth field can still be adjusted afterwards.
    $(document).on('change', '#dw-smart-bans', saveState);
    $(document).on('input', '#dw-strength-input', () => {
        $('#dw-depth-input').val(STRENGTH_LEVELS[getStrength()].depth);
        updateStrengthLabel();
        saveState();
    });
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
    $(document).on('click', '.dw-summary-tag', function() {
        if ($(this).hasClass('sum-inherited')) return; // belongs to the global set, not this character
        const txt = $(this).attr('data-tag') ?? $(this).text();
        $('.dw-tag').filter(function(){return getTagName(this)===txt;}).removeClass('active');
        saveState();
    });
    // Accordions: ignore clicks while animating (rapid clicks queued animations and
    // desynced the chevron), and set the chevron from the target state instead of toggling.
    const toggleSection = (title, contentSel, chevronSel) => {
        const content = $(title).next(contentSel);
        if (!content.length || content.is(':animated')) return;
        const willOpen = !content.is(':visible');
        $(title).find(chevronSel).toggleClass('fa-chevron-up', willOpen).toggleClass('fa-chevron-down', !willOpen);
        content.slideToggle(200);
    };
    $(document).on('click', '.dw-cat-title', function() { toggleSection(this, '.dw-cat-content', '.dw-chevron'); });
    $(document).on('click', '.dw-sub-title', function() { toggleSection(this, '.dw-sub-content', '.dw-chevron-sub'); });
    $(document).on('click', '#dw-custom-add', () => {
        const n = $('#dw-custom-name').val().trim(), p = $('#dw-custom-prompt').val().trim();
        const editing = $('#dw-custom-name').data('editing');
        let wasActive = $('#dw-custom-name').data('was-active');
        if (wasActive === undefined) wasActive = true;
        if (n && p) {
            if (editing && editing !== n && customPromptsData[editing]) {
                delete customPromptsData[editing];
                customNegative.delete(editing);
                $('.dw-custom-tag').filter(function() { return getTagName(this) === editing; }).remove();
            }
            if (customPromptsData[n]) {
                const existing = $('.dw-custom-tag').filter(function() { return getTagName(this) === n; });
                if (existing.hasClass('active')) wasActive = true;
                existing.remove();
            }
            customPromptsData[n] = p;
            if (getCustomKind() === 'negative') customNegative.add(n);
            else customNegative.delete(n);
            const el = buildCustomTagEl(n);
            if (wasActive) el.addClass('active');
            $('#dw-custom-tags-container').append(el);
            $('#dw-custom-name').val('').removeData('editing').removeData('was-active');
            $('#dw-custom-prompt').val('');
            setCustomKind('rule');
            $('#dw-custom-add').text('Создать тег');
            saveState(); 
        }
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
