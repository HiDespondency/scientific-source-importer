'use strict';

const path = require('path');
const { applyCyberleninkaMetadata, findCyberleninkaPdfUrl } = require('./cyberleninka');
const { extractHtmlMetadata, metaContent } = require('./html-metadata');
const { extractMetadataFromLocalPdf } = require('./pdf-metadata');
const {
	cleanText,
	bibliographicWarnings,
	decodeHtml,
	firstAuthorFamily,
	formatAuthors,
	isSafeHttpUrl,
	looksLikePdfUrl,
	mergeArrays,
	normalizeDoi,
	normalizePages,
	safeVaultPath,
	sanitizeFileName,
	yearFromDate
} = require('./utils');

class ImportService {
	constructor(app, settings, requestUrl) {
		this.app = app;
		this.settings = settings;
		this.requestUrl = requestUrl;
	}

	async importFromUrl(rawUrl) {
		if (!isSafeHttpUrl(rawUrl)) throw new Error('Небезопасная ссылка.');

		const result = {
			inputUrl: rawUrl,
			sourceUrl: rawUrl,
			pdfUrl: '',
			pdfPath: '',
			doi: '',
			metadata: {},
			provenance: [],
			warnings: []
		};

		if (looksLikePdfUrl(rawUrl)) {
			result.pdfUrl = rawUrl;
			result.warnings.push('Дана прямая ссылка на PDF: HTML-метаданные страницы не проверялись.');
		} else {
			const page = await this.fetchText(rawUrl);
			result.sourceUrl = page.finalUrl || rawUrl;
			result.provenance.push('HTML страницы');
			result.metadata = extractHtmlMetadata(page.text);
			applyCyberleninkaMetadata(result, page.text, this.mergeMetadata.bind(this));
			result.doi = normalizeDoi(result.metadata.doi) || normalizeDoi(page.text);
			result.pdfUrl = this.findPdfUrl(page.text, result.sourceUrl);
			if (!result.pdfUrl) result.warnings.push('PDF-ссылка на странице автоматически не найдена.');
		}

		if (!result.doi && result.pdfUrl) {
			const pdfHead = await this.fetchPdfHeadText(result.pdfUrl);
			result.doi = normalizeDoi(pdfHead);
			if (result.doi) result.provenance.push('DOI найден в PDF');
		}

		let crossrefChecked = false;
		if (result.doi) {
			await this.enrichMetadataFromCrossref(result);
			crossrefChecked = true;
		}

		if (result.pdfUrl) {
			try {
				result.pdfPath = await this.downloadPdf(result.pdfUrl, result.metadata, result.doi);
				result.provenance.push('PDF сохранён в хранилище');
			} catch (error) {
				throw new Error(`PDF не сохранён: ${error.message}`);
			}
		}
		if (!result.pdfPath) throw new Error('PDF не найден или не удалось сохранить его локально. Импорт отменён.');

		if (result.pdfPath) {
			await this.enrichIdentifiersFromSavedPdf(result);
		}

		if (result.doi && !crossrefChecked) {
			await this.enrichMetadataFromCrossref(result);
		}

		this.addFieldWarnings(result);

		this.lastImportResult = result;
		return result;
	}

	async fetchText(url) {
		const response = await this.requestUrl({
			url,
			method: 'GET',
			headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
			throw: false
		});
		if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
		return { text: response.text || '', headers: response.headers || {}, finalUrl: url };
	}

	async fetchArrayBuffer(url) {
		const response = await this.requestUrl({
			url,
			method: 'GET',
			headers: { 'Accept': 'application/pdf,*/*;q=0.8' },
			throw: false
		});
		if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
		return { arrayBuffer: response.arrayBuffer, headers: response.headers || {}, finalUrl: url };
	}

	findPdfUrl(html, baseUrl) {
		const metaPdf = metaContent(html, ['citation_pdf_url']);
		if (metaPdf) {
			const absolute = new URL(metaPdf, baseUrl).toString();
			if (isSafeHttpUrl(absolute)) return absolute;
		}
		const cyberleninka = findCyberleninkaPdfUrl(html, baseUrl);
		if (cyberleninka) return cyberleninka;
		const pattern = /<a\s+[^>]*href=["']([^"']*(?:\.pdf|\/pdf)(?:\?[^"']*)?)["'][^>]*>/ig;
		let match;
		while ((match = pattern.exec(html)) !== null) {
			try {
				const absolute = new URL(decodeHtml(match[1]), baseUrl).toString();
				if (isSafeHttpUrl(absolute)) return absolute;
			} catch (error) {
				continue;
			}
		}
		return '';
	}

	async fetchPdfHeadText(pdfUrl) {
		try {
			const response = await this.requestUrl({
				url: pdfUrl,
				method: 'GET',
				headers: { 'Range': 'bytes=0-200000', 'Accept': 'application/pdf,*/*;q=0.8' },
				throw: false
			});
			if ((response.status < 200 || response.status >= 300) && response.status !== 206) return '';
			const headBytes = response.arrayBuffer ? response.arrayBuffer.slice(0, 200000) : new ArrayBuffer(0);
			return Buffer.from(headBytes).toString('latin1');
		} catch (error) {
			return '';
		}
	}

	async fetchCrossref(doi) {
		const cleanDoi = normalizeDoi(doi);
		if (!cleanDoi) throw new Error('DOI пустой.');
		const response = await this.fetchText(`https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`);
		const json = JSON.parse(response.text);
		const message = json && json.message;
		if (!message) throw new Error('пустой ответ');
		const title = Array.isArray(message.title) ? message.title[0] : message.title;
		const container = Array.isArray(message['container-title']) ? message['container-title'][0] : message['container-title'];
		const dateParts = (message['published-print'] || message['published-online'] || message.issued || {})['date-parts'];
		const year = Array.isArray(dateParts) && dateParts[0] ? String(dateParts[0][0] || '') : '';
		return {
			title: title || '',
			authors: formatAuthors(message.author || []),
			publicationTitle: container || '',
			publisher: message.publisher || '',
			place: message['publisher-location'] || '',
			date: year,
			year,
			volume: message.volume || '',
			issue: message.issue || '',
			pages: normalizePages(message.page || ''),
			doi: cleanDoi,
			issn: Array.isArray(message.ISSN) ? message.ISSN.join(', ') : '',
			isbn: Array.isArray(message.ISBN) ? message.ISBN.join(', ') : cleanText(message.ISBN),
			issns: Array.isArray(message.ISSN) ? message.ISSN : [],
			url: message.URL || '',
			type: message.type || '',
			links: Array.isArray(message.link) ? message.link : []
		};
	}

	async enrichMetadataFromCrossref(result) {
		result.metadata = Object.assign({}, result.metadata || {}, { doi: normalizeDoi(result.doi) });
		try {
			const crossref = await this.fetchCrossref(result.doi);
			result.metadata = this.mergeMetadata(result.metadata, crossref);
			result.provenance.push('Crossref по DOI');
		} catch (error) {
			result.warnings.push(`Crossref не дал данные по DOI: ${error.message}`);
		}
	}

	async enrichIdentifiersFromSavedPdf(result) {
		const identifiers = await extractMetadataFromLocalPdf(this.absoluteVaultPath(result.pdfPath));
		const metadata = Object.assign({}, result.metadata || {});
		let enriched = false;
		for (const [field, value] of Object.entries(identifiers)) {
			const hasValue = Array.isArray(value) ? value.length > 0 : cleanText(value);
			const hasExisting = Array.isArray(metadata[field]) ? metadata[field].length > 0 : cleanText(metadata[field]);
			if (hasValue && !hasExisting) {
				metadata[field] = value;
				if (field === 'doi') result.doi = value;
				enriched = true;
			}
		}
		if (enriched) {
			result.metadata = metadata;
			result.provenance.push('Идентификаторы извлечены из PDF');
		}
	}

	absoluteVaultPath(vaultPath) {
		const cleanPath = cleanText(vaultPath).replace(/\\/g, '/');
		if (!cleanPath) return '';
		return path.join(this.app.vault.adapter.basePath, cleanPath);
	}

	mergeMetadata(primary, secondary) {
		const merged = Object.assign({}, primary || {});
		for (const [key, value] of Object.entries(secondary || {})) {
			if (Array.isArray(value)) {
				merged[key] = mergeArrays(Array.isArray(merged[key]) ? merged[key] : [], value);
			} else if (!cleanText(merged[key]) && cleanText(value)) {
				merged[key] = value;
			}
		}
		return merged;
	}

	addFieldWarnings(result) {
		result.warnings.push(...bibliographicWarnings(result.metadata || {}, 'автоматически'));
	}

	async downloadPdf(pdfUrl, metadata, doi) {
		if (!isSafeHttpUrl(pdfUrl)) throw new Error('небезопасная ссылка');
		const response = await this.fetchArrayBuffer(pdfUrl);
		const size = response.arrayBuffer ? response.arrayBuffer.byteLength : 0;
		const maxBytes = Math.max(1, this.settings.maxPdfMb) * 1024 * 1024;
		if (size > maxBytes) throw new Error(`PDF больше лимита ${this.settings.maxPdfMb} МБ`);
		const signature = response.arrayBuffer
			? Buffer.from(new Uint8Array(response.arrayBuffer).slice(0, 5)).toString('latin1')
			: '';
		if (signature !== '%PDF-') {
			throw new Error('ответ не похож на PDF');
		}

		const authors = formatAuthors(metadata.authors);
		const year = cleanText(metadata.year || yearFromDate(metadata.date));
		const title = cleanText(metadata.title) || normalizeDoi(doi) || 'Источник';
		const fileName = `${sanitizeFileName(`${firstAuthorFamily(authors)}${year ? ` ${year}` : ''} - ${title}`)}.pdf`;
		const vaultPath = await this.uniqueVaultPath(safeVaultPath(this.settings.sourceFilesDir, fileName));
		await this.ensureVaultFolder(path.posix.dirname(vaultPath));
		if (typeof this.app.vault.createBinary === 'function') {
			await this.app.vault.createBinary(vaultPath, response.arrayBuffer);
		} else {
			await this.app.vault.adapter.writeBinary(vaultPath, response.arrayBuffer);
		}
		return vaultPath;
	}

	async ensureVaultFolder(folderPath) {
		const normalized = cleanText(folderPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		if (!normalized || normalized === '.') return;
		const parts = normalized.split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!await this.app.vault.adapter.exists(current)) await this.app.vault.createFolder(current);
		}
	}

	async uniqueVaultPath(vaultPath) {
		const normalized = vaultPath.replace(/\\/g, '/');
		const parsed = path.posix.parse(normalized);
		let candidate = `${parsed.dir ? `${parsed.dir}/` : ''}${parsed.base}`;
		let index = 2;
		while (await this.app.vault.adapter.exists(candidate)) {
			candidate = `${parsed.dir ? `${parsed.dir}/` : ''}${parsed.name} (${index})${parsed.ext}`;
			index += 1;
		}
		return candidate;
	}
}

module.exports = { ImportService };
