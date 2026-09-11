'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { extractMetadataFromLocalPdf } = require('./pdf-metadata');
const { ImportService } = require('./import-service');
const { AutonomousResolver } = require('./autonomous-resolver');
const {
	cleanText,
	bibliographicWarnings,
	firstAuthorFamily,
	formatAuthors,
	normalizeDoi,
	normalizePages,
	sanitizeFileName,
	yearFromDate
} = require('./utils');

const execFileAsync = promisify(execFile);
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function bufferToArrayBuffer(buffer) {
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function isSafeLocalPdf(filePath, maxBytes) {
	const normalized = cleanText(filePath);
	if (!normalized || normalized.startsWith('\\\\')) return false;
	if (path.extname(normalized).toLowerCase() !== '.pdf') return false;
	const stat = fs.lstatSync(normalized);
	if (!stat.isFile() || stat.isSymbolicLink()) return false;
	return !maxBytes || stat.size <= maxBytes;
}

function pdfVaultPath(folder, baseName) {
	const cleanFolder = cleanText(folder).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	const cleanBase = sanitizeFileName(baseName, 'Источник').replace(/[. ]+$/g, '') || 'Источник';
	const fileName = `${cleanBase}.pdf`;
	return cleanFolder ? `${cleanFolder}/${fileName}` : fileName;
}

function normalizeZoteroDate(value) {
	const date = cleanText(value);
	const year = yearFromDate(date);
	if (date && year && /-00(?:-00)?\b/.test(date)) return year;
	return date;
}

class ZoteroImporter {
	constructor(app, settings, pluginDir, requestUrl) {
		this.app = app;
		this.settings = settings;
		this.pluginDir = pluginDir;
		this.importService = new ImportService(app, settings, requestUrl);
		this.autonomousResolver = new AutonomousResolver(this.importService);
	}

	async readZoteroItems(limit) {
		const scriptPath = path.join(this.pluginDir, 'zotero_import.ps1');
		const args = [
			'-NoProfile',
			'-ExecutionPolicy',
			'Bypass',
			'-File',
			scriptPath,
			'-ZoteroDir',
			cleanText(this.settings.zoteroDir),
			'-DbPath',
			cleanText(this.settings.zoteroDbPath),
			'-Limit',
			String(this.normalizeLimit(limit))
		];
		const { stdout } = await execFileAsync(POWERSHELL_EXE, args, {
			cwd: this.app.vault.adapter.basePath,
			windowsHide: true,
			maxBuffer: 50 * 1024 * 1024,
			timeout: 120000
		});
		const json = cleanText(stdout);
		if (!json) throw new Error('Zotero не вернул данные.');
		return JSON.parse(json);
	}

	async importAll(options = {}) {
		const data = await this.readZoteroItems(options.limit);
		const existingByZoteroKey = this.indexExistingByZoteroKey(options.existingSources || []);
		const results = [];
		const skipped = [];
		for (const item of data.items || []) {
			const zoteroKey = cleanText(item.zotero_key);
			const existing = zoteroKey ? existingByZoteroKey.get(zoteroKey) : null;
			if (existing?.pdfPath && this.app.vault.getAbstractFileByPath(existing.pdfPath)) {
				results.push(await this.reuseExistingItem(item, existing));
				continue;
			}
			try {
				results.push(await this.importItem(item));
			} catch (error) {
				skipped.push({
					title: cleanText(item.title) || zoteroKey || 'Источник Zotero',
					reason: error.message
				});
			}
		}
		return { results, skipped, source: data };
	}

	async importItem(item) {
		const metadata = this.toMetadata(item);
		const warnings = [];
		let pdfPath = '';
		let localPdfError = '';
		try {
			pdfPath = await this.copyPdf(item);
		} catch (error) {
			localPdfError = error.message;
			warnings.push(localPdfError);
		}
		let autonomous = { metadata, sourceUrl: cleanText(item.url), pdfUrl: '', provenance: [], warnings: [] };
		if (this.settings.autonomousZoteroEnrichment !== false) {
			autonomous = await this.autonomousResolver.enrich(metadata, item.url);
			Object.assign(metadata, autonomous.metadata);
			warnings.push(...autonomous.warnings);
			if (!pdfPath && autonomous.pdfUrl) {
				try {
					pdfPath = await this.importService.downloadPdf(autonomous.pdfUrl, metadata, metadata.doi);
					if (localPdfError) warnings.splice(warnings.indexOf(localPdfError), 1);
					autonomous.provenance.push('PDF скачан автономно по найденной официальной ссылке');
				} catch (error) {
					warnings.push(`Автономное скачивание PDF не удалось: ${error.message}`);
				}
			}
		}
		if (!pdfPath) throw new Error(`${warnings.join(' ')} Локальный PDF не найден; запись не создана.`);
		await this.enrichDoiFromPdf(metadata, this.absoluteVaultPath(pdfPath), warnings);
		if ((item.pdf_paths || []).length > 1) {
			warnings.push('У записи Zotero несколько PDF; импортирован первый файл.');
		}
		this.addFieldWarnings(metadata, warnings);
		return {
			inputUrl: cleanText(item.url),
			sourceUrl: autonomous.sourceUrl || cleanText(item.url),
			pdfUrl: autonomous.pdfUrl || '',
			pdfPath,
			doi: metadata.doi,
			metadata,
			provenance: ['Zotero SQLite', ...(pdfPath && (item.pdf_paths || []).length ? ['PDF скопирован из локального хранилища Zotero'] : []), ...autonomous.provenance],
			warnings
		};
	}

	async reuseExistingItem(item, existing) {
		const metadata = this.toMetadata(item);
		const warnings = [];
		let autonomous = { metadata, sourceUrl: cleanText(item.url || existing.sourceUrl), pdfUrl: '', provenance: [], warnings: [] };
		if (this.settings.autonomousZoteroEnrichment !== false) {
			autonomous = await this.autonomousResolver.enrich(metadata, item.url || existing.sourceUrl);
			Object.assign(metadata, autonomous.metadata);
			warnings.push(...autonomous.warnings);
		}
		await this.enrichDoiFromPdf(metadata, this.absoluteVaultPath(existing.pdfPath), warnings);
		this.addFieldWarnings(metadata, warnings);
		return {
			inputUrl: cleanText(item.url),
			sourceUrl: autonomous.sourceUrl || cleanText(item.url || existing.sourceUrl),
			pdfUrl: autonomous.pdfUrl || existing.result?.pdfUrl || '',
			pdfPath: existing.pdfPath,
			doi: metadata.doi,
			metadata,
			provenance: ['Zotero SQLite', 'PDF уже был скопирован в хранилище', ...autonomous.provenance],
			warnings
		};
	}

	toMetadata(item) {
		const authors = formatAuthors((item.authors || []).map((author) => ({
			first_name: author.first_name,
			last_name: author.last_name
		})));
		const date = normalizeZoteroDate(item.date);
		const year = yearFromDate(date);
		return {
			sourceType: cleanText(item.item_type) || 'article',
			citationKey: cleanText(item.citation_key),
			zoteroKey: cleanText(item.zotero_key),
			title: cleanText(item.title),
			shortTitle: cleanText(item.short_title),
			authors,
			publicationTitle: cleanText(item.publication_title),
			publisher: cleanText(item.publisher),
			place: cleanText(item.place),
			date,
			year,
			volume: cleanText(item.volume),
			issue: cleanText(item.issue),
			pages: normalizePages(item.pages),
			doi: normalizeDoi(item.doi),
			issn: cleanText(item.issn),
			eissn: cleanText(item.eissn),
			isbn: cleanText(item.isbn),
			udc: cleanText(item.udc),
			lccn: cleanText(item.lccn),
			grnti: cleanText(item.grnti),
			edn: cleanText(item.edn),
			pmid: cleanText(item.pmid),
			pmcid: cleanText(item.pmcid),
			arxiv: cleanText(item.arxiv),
			keywords: cleanText(item.keywords),
			accessDate: cleanText(item.access_date),
			edition: cleanText(item.edition),
			series: cleanText(item.series),
			seriesNumber: cleanText(item.series_number),
			libraryCatalog: cleanText(item.library_catalog),
			rights: cleanText(item.rights),
			extra: cleanText(item.extra),
			rawFields: item.raw_fields || {},
			url: cleanText(item.url),
			abstract: cleanText(item.abstract),
			language: cleanText(item.language)
		};
	}

	async enrichDoiFromPdf(metadata, pdfPath, warnings) {
		if (!pdfPath) return;
		const identifiers = await extractMetadataFromLocalPdf(pdfPath);
		let enriched = false;
		for (const [field, value] of Object.entries(identifiers)) {
			const hasValue = Array.isArray(value) ? value.length > 0 : cleanText(value);
			const hasExisting = Array.isArray(metadata[field]) ? metadata[field].length > 0 : cleanText(metadata[field]);
			if (hasValue && !hasExisting) {
				metadata[field] = value;
				enriched = true;
			}
		}
		if (enriched) metadata.identifiersSource = 'текстовый слой PDF';
	}

	absoluteVaultPath(vaultPath) {
		const cleanPath = cleanText(vaultPath).replace(/\\/g, '/');
		if (!cleanPath) return '';
		return path.join(this.app.vault.adapter.basePath, cleanPath);
	}

	async copyPdf(item) {
		const sourcePath = cleanText((item.pdf_paths || [])[0]);
		const maxBytes = Math.max(1, Number(this.settings.maxPdfMb) || 80) * 1024 * 1024;
		if (!isSafeLocalPdf(sourcePath, maxBytes)) throw new Error('PDF-вложение Zotero не найдено, небезопасно или больше лимита.');
		const metadata = this.toMetadata(item);
		const authors = formatAuthors(metadata.authors);
		const year = cleanText(metadata.year || yearFromDate(metadata.date));
		const title = metadata.title || path.basename(sourcePath, path.extname(sourcePath)) || 'Источник';
		const name = `${firstAuthorFamily(authors)}${year ? ` ${year}` : ''} - ${title}`;
		const vaultPath = await this.uniqueVaultPath(pdfVaultPath(this.settings.sourceFilesDir, name));
		await this.ensureVaultFolder(path.posix.dirname(vaultPath));
		const buffer = await fs.promises.readFile(sourcePath);
		const arrayBuffer = bufferToArrayBuffer(buffer);
		if (typeof this.app.vault.createBinary === 'function') {
			await this.app.vault.createBinary(vaultPath, arrayBuffer);
		} else {
			await this.app.vault.adapter.writeBinary(vaultPath, arrayBuffer);
		}
		return vaultPath;
	}

	indexExistingByZoteroKey(sources) {
		const map = new Map();
		for (const source of sources || []) {
			const key = cleanText(source.zoteroKey || source.result?.metadata?.zoteroKey);
			if (key && !map.has(key)) map.set(key, source);
		}
		return map;
	}

	recordToResult(record) {
		return record.result || {
			sourceUrl: record.sourceUrl || '',
			pdfPath: record.pdfPath || '',
			metadata: {
				title: record.title || '',
				authors: record.authors ? [record.authors] : [],
				year: record.year || '',
				publicationTitle: record.publicationTitle || '',
				zoteroKey: record.zoteroKey || '',
				citationKey: record.citationKey || ''
			},
			warnings: []
		};
	}

	addFieldWarnings(metadata, warnings) {
		warnings.push(...bibliographicWarnings(metadata, 'в Zotero или PDF'));
	}

	normalizeLimit(limit) {
		const parsed = Number.parseInt(limit || this.settings.zoteroImportLimit, 10);
		if (!Number.isFinite(parsed) || parsed < 1) return 500;
		return Math.min(parsed, 5000);
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

module.exports = { ZoteroImporter };
