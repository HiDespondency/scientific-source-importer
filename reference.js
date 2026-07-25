'use strict';

const { cleanText, formatAuthors, normalizePages } = require('./utils');

function withPeriod(value) {
	const text = cleanText(value);
	if (!text) return '';
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

function todayRu() {
	const date = new Date();
	const day = String(date.getDate()).padStart(2, '0');
	const month = String(date.getMonth() + 1).padStart(2, '0');
	return `${day}-${month}-${date.getFullYear()}`;
}

function buildReference(metadata, sourceUrl) {
	const authors = formatAuthors(metadata.authors);
	const parts = [];
	if (authors.length) parts.push(withPeriod(authors.join(', ')));
	if (metadata.title) parts.push(metadata.publicationTitle || sourceUrl ? `${cleanText(metadata.title)} //` : withPeriod(metadata.title));
	if (metadata.publicationTitle) parts.push(withPeriod(metadata.publicationTitle));
	if (metadata.year) parts.push(withPeriod(metadata.year));
	if (metadata.issue && metadata.volume) parts.push(withPeriod(`Т. ${metadata.volume}, № ${metadata.issue}`));
	else if (metadata.issue) parts.push(withPeriod(`№ ${metadata.issue}`));
	else if (metadata.volume) parts.push(withPeriod(`Т. ${metadata.volume}`));
	if (metadata.pages) parts.push(withPeriod(`С. ${normalizePages(metadata.pages)}`));
	if (metadata.doi) parts.push(withPeriod(`DOI: ${cleanText(metadata.doi)}`));
	if (sourceUrl) parts.push(`URL: ${sourceUrl} (дата обращения: ${todayRu()}).`);
	return parts.filter(Boolean).join(' ');
}

module.exports = { buildReference };
