'use strict';

const { extractHtmlMetadata } = require('./html-metadata');
const {
	cleanText,
	formatAuthors,
	isSafeHttpUrl,
	normalizeDoi,
	normalizePages,
	yearFromDate
} = require('./utils');

function normalizeTitle(value) {
	return cleanText(value)
		.toLowerCase()
		.replace(/[“”„‟"'`]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

function titleSimilarity(left, right) {
	const a = normalizeTitle(left);
	const b = normalizeTitle(right);
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.includes(b) || b.includes(a)) return 0.9;
	const aTokens = new Set(a.split(' ').filter((token) => token.length > 2));
	const bTokens = new Set(b.split(' ').filter((token) => token.length > 2));
	if (!aTokens.size || !bTokens.size) return 0;
	let intersection = 0;
	for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
	return intersection / new Set([...aTokens, ...bTokens]).size;
}

function sourceTypeFromCrossref(type, fallback) {
	const normalized = cleanText(type).toLowerCase();
	if (normalized === 'journal-article') return 'journalArticle';
	if (normalized === 'proceedings-article') return 'conferencePaper';
	if (normalized === 'book-chapter') return 'bookSection';
	if (normalized === 'book' || normalized === 'monograph') return 'book';
	if (normalized === 'report') return 'report';
	return fallback || '';
}

class AutonomousResolver {
	constructor(importService) {
		this.importService = importService;
	}

	async enrich(metadata, itemUrl) {
		const next = Object.assign({}, metadata || {});
		const provenance = [];
		const warnings = [];
		let sourceUrl = cleanText(itemUrl);
		let pdfUrl = '';
		let matchedRemote = null;
		let rejectedDoi = '';

		if (next.doi) {
			try {
				const remote = await this.importService.fetchCrossref(next.doi);
				if (titleSimilarity(next.title, remote.title) >= 0.5) {
					matchedRemote = remote;
				} else {
					rejectedDoi = next.doi;
					next.doi = '';
					warnings.push('Crossref отклонён: название работы не совпало с записью Zotero.');
				}
			} catch (error) {
				warnings.push(`Автопоиск по DOI не дал данных: ${error.message}`);
			}
		}

		if (!matchedRemote && next.title) {
			try {
				matchedRemote = await this.searchCrossref(next);
				if (matchedRemote) provenance.push('Crossref: поиск по названию и авторам');
			} catch (error) {
				warnings.push(`Автопоиск Crossref не выполнен: ${error.message}`);
			}
		}

		if (matchedRemote) {
			const remoteMetadata = this.crossrefMetadata(matchedRemote);
			Object.assign(next, this.mergeMissing(next, remoteMetadata));
			if (matchedRemote.doi && (!next.doi || rejectedDoi)) next.doi = matchedRemote.doi;
			pdfUrl = this.selectPdfLink(matchedRemote.links);
			sourceUrl = cleanText(matchedRemote.url) || sourceUrl;
			provenance.push('Crossref: подтверждённая библиографическая запись');
		}

		const pages = [sourceUrl, itemUrl];
		if (next.doi) pages.push(`https://doi.org/${normalizeDoi(next.doi)}`);
		for (const pageUrl of [...new Set(pages.map(cleanText).filter(isSafeHttpUrl))]) {
			try {
				const page = await this.importService.fetchText(pageUrl);
				const htmlMetadata = extractHtmlMetadata(page.text);
				Object.assign(next, this.mergeMissing(next, htmlMetadata));
				const candidate = this.importService.findPdfUrl(page.text, page.finalUrl || pageUrl);
				if (!pdfUrl && candidate) pdfUrl = candidate;
				if (page.finalUrl && page.finalUrl !== pageUrl) sourceUrl = page.finalUrl;
				provenance.push(`HTML: ${new URL(pageUrl).host}`);
				if (candidate) provenance.push('HTML: найдена PDF-ссылка');
			} catch (error) {
				warnings.push(`Не удалось проверить ${pageUrl}: ${error.message}`);
			}
		}

		return {
			metadata: next,
			sourceUrl,
			pdfUrl,
			provenance,
			warnings
		};
	}

	async searchCrossref(metadata) {
		const query = [metadata.title, ...(formatAuthors(metadata.authors).slice(0, 2))].filter(Boolean).join(' ');
		if (!query) return null;
		const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=5`;
		const response = await this.importService.fetchText(url);
		const items = JSON.parse(response.text)?.message?.items || [];
		let best = null;
		let bestScore = 0;
		for (const item of items) {
			const score = titleSimilarity(metadata.title, Array.isArray(item.title) ? item.title[0] : item.title);
			if (score > bestScore) {
				best = item;
				bestScore = score;
			}
		}
		return bestScore >= 0.72 ? this.crossrefWork(best) : null;
	}

	crossrefWork(item) {
		if (!item) return null;
		const dateParts = (item['published-print'] || item['published-online'] || item.issued || {})['date-parts'];
		const year = Array.isArray(dateParts) && dateParts[0] ? String(dateParts[0][0] || '') : '';
		return {
			title: Array.isArray(item.title) ? item.title[0] : item.title,
			authors: formatAuthors(item.author || []),
			publicationTitle: Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'],
			publisher: item.publisher || '',
			place: item['publisher-location'] || '',
			date: year,
			year,
			volume: item.volume || '',
			issue: item.issue || '',
			pages: normalizePages(item.page || ''),
			doi: normalizeDoi(item.DOI),
			issn: Array.isArray(item.ISSN) ? item.ISSN.join(', ') : '',
			isbn: Array.isArray(item.ISBN) ? item.ISBN.join(', ') : cleanText(item.ISBN),
			url: item.URL || '',
			type: item.type || '',
			links: item.link || []
		};
	}

	crossrefMetadata(remote) {
		return Object.assign({}, remote, {
			sourceType: sourceTypeFromCrossref(remote.type, ''),
			doi: normalizeDoi(remote.doi),
			pages: normalizePages(remote.pages),
			date: cleanText(remote.date),
			year: cleanText(remote.year || yearFromDate(remote.date)),
			links: undefined,
			type: undefined
		});
	}

	selectPdfLink(links) {
		for (const link of links || []) {
			const url = cleanText(link.URL || link.url);
			const contentType = cleanText(link['content-type'] || link.contentType).toLowerCase();
			if (isSafeHttpUrl(url) && (contentType.includes('pdf') || /\.pdf(?:$|[?#])/i.test(url))) return url;
		}
		return '';
	}

	mergeMissing(primary, secondary) {
		const merged = Object.assign({}, primary || {});
		for (const [key, value] of Object.entries(secondary || {})) {
			if (key === 'links' || key === 'type') continue;
			if (Array.isArray(value)) {
				if (!Array.isArray(merged[key]) || !merged[key].length) merged[key] = value;
			} else if (!cleanText(merged[key]) && cleanText(value)) {
				merged[key] = value;
			}
		}
		return merged;
	}
}

module.exports = { AutonomousResolver, titleSimilarity };
