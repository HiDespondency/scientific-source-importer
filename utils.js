'use strict';

const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;
const DOI_LOOKALIKE_LETTERS = {
	А: 'A',
	В: 'B',
	Е: 'E',
	К: 'K',
	М: 'M',
	Н: 'H',
	О: 'O',
	Р: 'P',
	С: 'C',
	Т: 'T',
	Х: 'X',
	а: 'a',
	в: 'b',
	е: 'e',
	к: 'k',
	м: 'm',
	н: 'h',
	о: 'o',
	р: 'p',
	с: 'c',
	т: 't',
	х: 'x'
};

function cleanText(value) {
	return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
	return String(value || '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>');
}

function escapeRegex(value) {
	return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSafeHttpUrl(value) {
	try {
		const url = new URL(String(value || ''));
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch (error) {
		return false;
	}
}

function looksLikePdfUrl(value) {
	try {
		const url = new URL(value);
		return /\.pdf(?:$|[?#])/i.test(url.pathname + url.search) || /\/pdf$/i.test(url.pathname);
	} catch (error) {
		return false;
	}
}

function normalizeDoi(value) {
	const normalized = String(value || '').replace(/[АВЕКМНОРСТХавекмнорстх]/g, (letter) => DOI_LOOKALIKE_LETTERS[letter] || letter);
	const match = normalized.match(DOI_PATTERN);
	return match ? match[0].replace(/[.,;)\]]+$/g, '') : '';
}

function yearFromDate(value) {
	const match = String(value || '').match(/\b(19|20)\d{2}\b/);
	return match ? match[0] : '';
}

function normalizePages(value) {
	return cleanText(value).replace(/-/g, '–');
}

function normalizePageRange(firstPage, lastPage, pages) {
	const explicit = normalizePages(pages);
	if (explicit) return explicit;
	const first = cleanText(firstPage);
	const last = cleanText(lastPage);
	if (first && last && first !== last) return `${first}–${last}`;
	return first || last || '';
}

function sanitizeFileName(value, fallback = 'Источник') {
	const text = cleanText(value)
		.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 150);
	return text || fallback;
}

function safeVaultPath(folder, fileName) {
	const cleanFolder = cleanText(folder).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	const cleanFile = sanitizeFileName(fileName);
	return cleanFolder ? `${cleanFolder}/${cleanFile}` : cleanFile;
}

function splitKeywords(value) {
	return cleanText(value)
		.split(/[;,]/)
		.map((item) => cleanText(item))
		.filter(Boolean);
}

function hostFromUrl(value) {
	try {
		return new URL(value).hostname.replace(/^www\./i, '');
	} catch (error) {
		return '';
	}
}

function isoTimestamp() {
	return new Date().toISOString();
}

function formatAuthors(authors) {
	return (authors || []).map((author) => {
		if (typeof author === 'string') return cleanText(author);
		const given = cleanText(author.given || author.firstName || author.first_name);
		const family = cleanText(author.family || author.lastName || author.last_name || author.name);
		return cleanText([family, given].filter(Boolean).join(' '));
	}).filter(Boolean);
}

function firstAuthorFamily(authors) {
	const first = formatAuthors(authors)[0] || 'Без автора';
	return cleanText(first.split(/\s+/)[0]) || 'Без автора';
}

function stableHash(value) {
	let hash = 2166136261;
	for (const character of String(value || '')) {
		hash ^= character.codePointAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function citationKeyPart(value, fallback = '') {
	const normalized = cleanText(value)
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, '');
	return normalized || fallback;
}

function buildCitationKey(metadata = {}, identity = '') {
	const explicit = cleanText(metadata.citationKey || metadata.zoteroKey);
	if (explicit) return explicit;

	const authors = formatAuthors(metadata.authors);
	const author = citationKeyPart(firstAuthorFamily(authors), 'Источник');
	const year = citationKeyPart(metadata.year || yearFromDate(metadata.date));
	const title = citationKeyPart(metadata.shortTitle || metadata.title, 'Источник');
	const basis = cleanText(identity)
		|| cleanText(metadata.doi)
		|| cleanText(metadata.url)
		|| [author, year, title].filter(Boolean).join('|');
	const suffix = stableHash(basis);
	return `${author}${year}${title}${suffix}`.slice(0, 120);
}

function mergeArrays(primary, secondary) {
	const values = [];
	for (const value of [...(primary || []), ...(secondary || [])]) {
		const clean = cleanText(value);
		if (clean && !values.includes(clean)) values.push(clean);
	}
	return values;
}

function bibliographicWarnings(metadata = {}, origin = 'автоматически') {
	const has = (value) => Array.isArray(value) ? value.length > 0 : !!cleanText(value);
	const warnings = [];
	const type = cleanText(metadata.sourceType).toLowerCase();
	const bookLike = ['book', 'booksection', 'thesis', 'report'].includes(type);
	const articleLike = ['article', 'journalarticle', 'conferencepaper'].includes(type)
		|| (!bookLike && (has(metadata.publicationTitle) || has(metadata.volume) || has(metadata.issue) || has(metadata.pages)));
	const missing = (field, label) => {
		if (!has(field)) warnings.push(`Обязательное поле «${label}» не найдено ${origin}.`);
	};

	missing(metadata.title, 'название');
	if (articleLike) {
		missing(metadata.publicationTitle, 'журнал / издание');
		missing(metadata.year || metadata.date, 'год');
		if (!has(metadata.volume) && !has(metadata.issue)) warnings.push(`Обязательное поле «том / выпуск» не найдено ${origin}.`);
		if (!has(metadata.pages) && !has(metadata.articleNumber) && !has(metadata.elocation)) {
			warnings.push(`Обязательное поле «страницы или номер статьи» не найдено ${origin}.`);
		}
	} else if (bookLike) {
		missing(metadata.year || metadata.date, 'год');
		missing(metadata.publisher, 'издательство');
		missing(metadata.place, 'место издания');
		if (['book', 'booksection'].includes(type) && !has(metadata.isbn)) {
			warnings.push(`Обязательное поле «ISBN» не найдено ${origin}.`);
		}
	}
	return warnings;
}

function responseHeader(headers, name) {
	const target = String(name || '').toLowerCase();
	for (const [key, value] of Object.entries(headers || {})) {
		if (String(key).toLowerCase() === target) return String(value || '');
	}
	return '';
}

module.exports = {
	buildCitationKey,
	bibliographicWarnings,
	cleanText,
	decodeHtml,
	escapeRegex,
	firstAuthorFamily,
	formatAuthors,
	hostFromUrl,
	isSafeHttpUrl,
	isoTimestamp,
	looksLikePdfUrl,
	mergeArrays,
	normalizeDoi,
	normalizePages,
	normalizePageRange,
	responseHeader,
	safeVaultPath,
	sanitizeFileName,
	splitKeywords,
	yearFromDate
};
