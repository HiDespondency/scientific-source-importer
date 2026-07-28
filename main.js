'use strict';

const { ItemView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, normalizePath, requestUrl, setIcon } = require('obsidian');
const { RangeSetBuilder } = require('@codemirror/state');
const { Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
const path = require('path');
const { shell } = require('electron');

let ImportService;
let ZoteroImporter;
let buildReference;

const VIEW_TYPE_SOURCE_DETAILS = 'scientific-source-importer-details';
const SOURCE_PANEL_MIN_WIDTH = 490;
const CITATION_ORDER_CACHE_LIMIT = 25;
const LAST_USED_SAVE_INTERVAL_MS = 30000;
const CITE_PATTERN = /\[@([A-Za-zА-Яа-яЁё0-9:.#$%&\-+?<>~_/]+)\]/g;

const DEFAULT_SETTINGS = {
	sourceFilesDir: 'Материалы/Импорт источников',
	openAfterImport: true,
	maxPdfMb: 80,
	zoteroDir: '',
	zoteroDbPath: '',
	zoteroImportLimit: 500,
	importedSources: []
};

const LEGACY_SETTINGS = {
	sourceFilesDir: 'Научные штуки/Ядро/Материалы/Импорт источников'
};

function cleanText(value) {
	return String(value || '').replace(/\s+/g, ' ').trim();
}

function isSafeHttpUrl(value) {
	try {
		const url = new URL(String(value || ''));
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch (error) {
		return false;
	}
}

function formatAuthors(value) {
	if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
	return cleanText(value) ? [cleanText(value)] : [];
}

function yearFromDate(value) {
	const match = cleanText(value).match(/\b(18|19|20)\d{2}\b/);
	return match ? match[0] : '';
}

function setText(el, value, fallback = '—') {
	el.textContent = cleanText(value) || fallback;
}

function formatPages(value) {
	return cleanText(value).replace(/\s*[-–—]\s*/g, ' – ');
}

function formatDateValue(date, year) {
	const cleanDate = cleanText(date);
	const cleanYear = cleanText(year || yearFromDate(cleanDate));
	if (!cleanDate) return cleanYear;
	if (cleanYear && /-00(?:-00)?\b/.test(cleanDate)) return cleanYear;
	if (cleanYear && cleanDate.replace(/\b(19|20)\d{2}\b/g, '').replace(/[-.\/\s0]/g, '') === '') return cleanYear;
	const isoDate = /^((?:18|19|20)\d{2})[-.\/](\d{1,2})[-.\/](\d{1,2})$/.exec(cleanDate);
	if (isoDate) return `${isoDate[3].padStart(2, '0')}-${isoDate[2].padStart(2, '0')}-${isoDate[1]}`;
	const ruDate = /^(\d{1,2})[-.\/](\d{1,2})[-.\/]((?:18|19|20)\d{2})$/.exec(cleanDate);
	if (ruDate) return `${ruDate[1].padStart(2, '0')}-${ruDate[2].padStart(2, '0')}-${ruDate[3]}`;
	return cleanDate;
}

function baseName(vaultPath) {
	return cleanText(vaultPath).split('/').filter(Boolean).pop() || '';
}

function typeLabel(type) {
	const labels = {
		article: 'Журнальная статья',
		journalArticle: 'Журнальная статья',
		book: 'Книга',
		bookSection: 'Глава / раздел книги',
		conferencePaper: 'Материал конференции',
		thesis: 'Диссертация',
		report: 'Отчёт',
		webpage: 'Веб-страница'
	};
	return labels[cleanText(type)] || cleanText(type) || 'Источник';
}

function collectCitationOrder(text) {
	const order = new Map();
	let match;
	while ((match = CITE_PATTERN.exec(text)) !== null) {
		const key = match[1];
		if (!order.has(key)) order.set(key, order.size + 1);
	}
	CITE_PATTERN.lastIndex = 0;
	return order;
}

function extractCitations(text) {
	const order = collectCitationOrder(text);
	const citations = [];
	let match;
	while ((match = CITE_PATTERN.exec(text)) !== null) {
		citations.push({
			from: match.index,
			to: match.index + match[0].length,
			key: match[1],
			number: order.get(match[1])
		});
	}
	CITE_PATTERN.lastIndex = 0;
	return citations;
}

class SourceCitationWidget extends WidgetType {
	constructor(number, key) {
		super();
		this.number = number;
		this.key = key;
	}

	toDOM() {
		const span = document.createElement('span');
		span.className = 'scientific-source-inline-cite';
		span.textContent = `[${this.number}]`;
		span.title = this.key;
		return span;
	}
}

function buildCitationDecorations(state) {
	const builder = new RangeSetBuilder();
	for (const citation of extractCitations(state.doc.toString())) {
		builder.add(
			citation.from,
			citation.to,
			Decoration.replace({
				widget: new SourceCitationWidget(citation.number, citation.key)
			})
		);
	}
	return builder.finish();
}

function createCitationExtension() {
	return ViewPlugin.fromClass(
		class {
			constructor(view) {
				this.decorations = buildCitationDecorations(view.state);
			}

			update(update) {
				if (update.docChanged) {
					this.decorations = buildCitationDecorations(update.state);
				}
			}
		},
		{
			decorations: (plugin) => plugin.decorations
		}
	);
}

class SourceDetailsView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_SOURCE_DETAILS;
	}

	getDisplayText() {
		return 'Информация об источнике';
	}

	getIcon() {
		return 'library';
	}

	async onOpen() {
		this.render();
	}

	setSource(result) {
		this.mode = 'details';
		this.result = result;
		this.render();
	}

	showList() {
		this.mode = 'list';
		this.render();
	}

	showNoteCitations(file, citeKeys, result) {
		this.mode = 'noteCitations';
		this.noteFile = file;
		this.noteCiteKeys = citeKeys || [];
		this.noteCitationResult = result || { references: [], unresolved: [] };
		this.render();
	}

	render() {
		const container = this.containerEl.children[1];
		if (!container) return;
		container.replaceChildren();
		container.classList.add('scientific-source-details');

		if (this.mode === 'noteCitations') {
			this.renderNoteCitations(container);
			return;
		}

		if (this.mode === 'list' || !this.result && !this.plugin.currentSource?.result) {
			this.renderSourceList(container);
			return;
		}

		const result = this.result || this.plugin.currentSource?.result;
		const metadata = result.metadata || {};
		const authors = formatAuthors(metadata.authors);
		const title = cleanText(metadata.title) || 'Источник без названия';
		const year = cleanText(metadata.year || yearFromDate(metadata.date));
		const reference = buildReference ? buildReference(Object.assign({}, metadata, { year }), result.sourceUrl) : '';
		const citationKey = cleanText(metadata.citationKey || metadata.zoteroKey);
		const obsidianReference = citationKey ? `[@${citationKey}]` : '';

		const header = this.createElement(container, 'div', { cls: 'scientific-source-details-header' });
		const backButton = this.createElement(header, 'button', { cls: 'scientific-source-details-back', text: '←' });
		backButton.title = 'Вернуться к списку источников';
		backButton.addEventListener('click', () => this.showList());

		this.createElement(container, 'h3', { text: title });
		this.createElement(container, 'div', {
			cls: 'scientific-source-details-subtitle',
			text: `${authors.join(', ') || 'Автор не найден'}${year ? ` (${year})` : ''}`
		});

		const actions = this.createElement(container, 'div', { cls: 'scientific-source-details-actions scientific-source-details-primary-actions' });
		this.addPanelAction(actions, 'Открыть PDF во внешнем приложении', () => this.openExternalPath(result.pdfPath), !result.pdfPath);
		this.addPanelAction(actions, 'Открыть во внутреннем браузере', () => result.sourceUrl && window.open(result.sourceUrl), !result.sourceUrl);

		const section = this.createElement(container, 'div', { cls: 'scientific-source-details-section' });
		this.createElement(section, 'h4', { text: 'Информация' });
		this.addRow(section, 'Тип записи', typeLabel(metadata.sourceType), { field: 'sourceType', rawValue: metadata.sourceType, normalize: typeLabel });
		this.addRow(section, 'Название', title, { field: 'title', rawValue: metadata.title || title });
		this.addRow(section, 'Автор', authors.join(', '), { field: 'authors', rawValue: authors.join(', ') });
		this.addRow(section, 'Публикация', metadata.publicationTitle, { field: 'publicationTitle', rawValue: metadata.publicationTitle });
		this.addRow(section, 'Издатель', metadata.publisher, { field: 'publisher', rawValue: metadata.publisher });
		this.addRow(section, 'Место', metadata.place, { field: 'place', rawValue: metadata.place });
		this.addRow(section, 'Дата', formatDateValue(metadata.date, year), { field: 'date', rawValue: metadata.date || year, normalize: (value) => formatDateValue(value, yearFromDate(value)) });
		this.addRow(section, 'Том', metadata.volume, { field: 'volume', rawValue: metadata.volume });
		this.addRow(section, 'Выпуск', metadata.issue, { field: 'issue', rawValue: metadata.issue });
		this.addRow(section, 'Страницы', formatPages(metadata.pages), { field: 'pages', rawValue: metadata.pages, normalize: formatPages });
		this.addRow(section, 'DOI', result.doi || metadata.doi, { field: 'doi', rawValue: result.doi || metadata.doi });
		this.addRow(section, 'ISSN', metadata.issn, { field: 'issn', rawValue: metadata.issn });
		this.addRow(section, 'eISSN', metadata.eissn, { field: 'eissn', rawValue: metadata.eissn });
		this.addUrlRow(section, 'URL-адрес', result.sourceUrl);
		this.addRow(section, 'PDF', baseName(result.pdfPath));
		this.addRow(section, 'Библ. каталог', this.hostFromUrl(result.sourceUrl));

		const referenceSection = this.createElement(container, 'div', { cls: 'scientific-source-details-section' });
		const referenceHeader = this.createElement(referenceSection, 'div', { cls: 'scientific-source-details-section-header' });
		this.createElement(referenceHeader, 'h4', { text: 'Ссылка:' });
		const copyActions = this.createElement(referenceHeader, 'div', { cls: 'scientific-source-details-copy-actions' });
		this.createElement(copyActions, 'span', { cls: 'scientific-source-details-copy-label', text: 'Копировать' });
		this.addPanelAction(copyActions, 'ГОСТ сноску', () => this.copyText(reference, 'ГОСТ-сноска скопирована.'), !cleanText(reference));
		this.addPanelAction(copyActions, 'Obsidian сноску', () => this.copyText(obsidianReference, 'Obsidian-сноска скопирована.'), !obsidianReference);
		const referenceEl = this.createElement(referenceSection, 'div', { cls: 'scientific-source-details-text' });
		setText(referenceEl, reference, 'Требуется ручное оформление ссылки.');

		const checks = [...new Set((result.warnings || []).filter(Boolean))];
		if (checks.length) {
			const checksSection = this.createElement(container, 'div', { cls: 'scientific-source-details-section' });
			this.createElement(checksSection, 'h4', { text: 'Что проверить' });
			const list = this.createElement(checksSection, 'ul');
			for (const item of checks) this.createElement(list, 'li', { text: item });
		}
	}

	renderSourceList(container) {
		this.createElement(container, 'h3', { text: 'Добавленные источники' });
		this.renderPanelTabs(container, 'sources');
		const sources = this.plugin.settings.importedSources || [];
		if (!sources.length) {
			this.createElement(container, 'p', {
				cls: 'scientific-source-details-empty',
				text: 'Импортированных источников пока нет.'
			});
			return;
		}

		const search = this.createElement(container, 'input', {
			cls: 'scientific-source-list-search'
		});
		search.type = 'search';
		search.placeholder = 'Поиск по названию, автору, журналу или году';

		const sort = this.createElement(container, 'select', {
			cls: 'scientific-source-list-sort'
		});
		this.addOption(sort, 'lastUsed', 'Последние использованные');
		this.addOption(sort, 'date', 'Дата публикации');
		this.addOption(sort, 'az', 'А–Я');

		const list = this.createElement(container, 'div', { cls: 'scientific-source-list' });
		const renderItems = () => {
			list.replaceChildren();
			const query = cleanText(search.value).toLowerCase();
			const filtered = sources.filter((source) => {
				const haystack = [
					baseName(source.pdfPath),
					source.title,
					source.authors,
					source.year,
					source.publicationTitle
				].map(cleanText).join(' ').toLowerCase();
				return !query || haystack.includes(query);
			}).sort((a, b) => this.compareSources(a, b, sort.value));
			for (const source of filtered) {
				const button = this.createElement(list, 'button', { cls: 'scientific-source-list-item' });
				const displayName = baseName(source.pdfPath) || cleanText(source.title) || 'Источник';
				this.createElement(button, 'div', { cls: 'scientific-source-list-title', text: displayName });
				const meta = [cleanText(source.authors), cleanText(source.year), cleanText(source.publicationTitle)].filter(Boolean).join(' · ');
				if (meta) this.createElement(button, 'div', { cls: 'scientific-source-list-meta', text: meta });
				button.addEventListener('click', () => void this.plugin.openImportedRecord(source));
			}
			if (!filtered.length) {
				this.createElement(list, 'p', { cls: 'scientific-source-details-empty', text: 'Ничего не найдено.' });
			}
		};
		search.addEventListener('input', renderItems);
		sort.addEventListener('change', renderItems);
		renderItems();
	}

	renderNoteCitations(container) {
		const result = this.noteCitationResult || { references: [], unresolved: [] };
		const fileName = this.noteFile?.basename || 'Текущая заметка';
		const header = this.createElement(container, 'div', { cls: 'scientific-source-citations-header' });
		this.createElement(header, 'div', { cls: 'scientific-source-citations-title', text: 'Ссылки текущей заметки' });
		this.renderPanelTabs(container, 'citations');
		this.createElement(container, 'div', {
			cls: 'scientific-source-citations-meta',
			text: `${fileName} · ключей: ${this.noteCiteKeys.length} · найдено: ${result.references.length}`
		});

		if (result.unresolved.length) {
			const warning = this.createElement(container, 'div', { cls: 'scientific-source-citations-warning' });
			this.createElement(warning, 'div', { text: 'Не найдены ключи:' });
			const list = this.createElement(warning, 'ul', { cls: 'scientific-source-citations-plain-list' });
			for (const key of result.unresolved) this.createElement(list, 'li', { text: key });
		}

		if (!result.references.length) {
			this.createElement(container, 'p', {
				cls: 'scientific-source-citations-message',
				text: 'В текущей заметке нет найденных источников из базы importer.'
			});
			return;
		}

		const list = this.createElement(container, 'div', { cls: 'scientific-source-citations-list' });
		for (const reference of result.references) {
			const entry = this.createElement(list, 'div', { cls: 'scientific-source-citations-entry' });
			this.createElement(entry, 'div', {
				cls: 'scientific-source-citations-entry-text',
				text: `${reference.number}. ${reference.text}`
			});
			const actions = this.createElement(entry, 'div', { cls: 'scientific-source-citations-actions' });
			const hasPdf = !!(reference.record?.pdfPath || reference.record?.result?.pdfPath);
			this.addCitationAction(actions, 'Подробнее', () => this.plugin.openImportedRecordDetails(reference.record), !reference.record);
			this.addCitationAction(actions, 'Открыть оригинал', () => this.plugin.openRecordPdfInNewTab(reference.record), !hasPdf);
		}
	}

	renderPanelTabs(container, active) {
		const tabs = this.createElement(container, 'div', { cls: 'scientific-source-panel-tabs' });
		const sourcesButton = this.createElement(tabs, 'button', {
			cls: active === 'sources' ? 'is-active' : '',
			text: 'Источники'
		});
		sourcesButton.addEventListener('click', () => this.showList());

		const citationsButton = this.createElement(tabs, 'button', {
			cls: active === 'citations' ? 'is-active' : '',
			text: 'Ссылки'
		});
		citationsButton.addEventListener('click', () => this.plugin.showCitationsInView(this));
	}

	addCitationAction(parent, label, callback, disabled) {
		const button = this.createElement(parent, 'button', { cls: 'scientific-source-citations-button', text: label });
		button.disabled = !!disabled;
		button.addEventListener('click', () => void callback());
	}

	addOption(parent, value, text) {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = text;
		parent.appendChild(option);
	}

	compareSources(a, b, mode) {
		if (mode === 'az') {
			return cleanText(a.title || baseName(a.pdfPath)).localeCompare(cleanText(b.title || baseName(b.pdfPath)), 'ru');
		}
		if (mode === 'date') {
			return this.sourceYear(b) - this.sourceYear(a)
				|| cleanText(a.title).localeCompare(cleanText(b.title), 'ru');
		}
		return cleanText(b.lastUsedAt || '').localeCompare(cleanText(a.lastUsedAt || ''))
			|| cleanText(b.importedAt || '').localeCompare(cleanText(a.importedAt || ''))
			|| cleanText(a.title).localeCompare(cleanText(b.title), 'ru');
	}

	sourceYear(source) {
		const year = Number.parseInt(cleanText(source.year || source.result?.metadata?.year || yearFromDate(source.result?.metadata?.date)), 10);
		return Number.isFinite(year) ? year : 0;
	}

	addPanelAction(parent, label, callback, disabled) {
		const button = this.createElement(parent, 'button');
		button.title = label;
		this.createElement(button, 'span', { cls: 'scientific-source-action-label', text: label });
		button.disabled = !!disabled;
		button.addEventListener('click', () => void callback());
	}

	addRow(parent, label, value, editOptions = null) {
		const row = this.createElement(parent, 'div', { cls: 'scientific-source-details-row' });
		this.createElement(row, 'div', { cls: 'scientific-source-details-label', text: label });
		const valueEl = this.createElement(row, 'div', { cls: 'scientific-source-details-value' });
		setText(valueEl, value, 'н/д');
		if (!editOptions?.field) return;

		const actions = this.createElement(row, 'div', { cls: 'scientific-source-field-actions' });
		const editButton = this.createIconButton(actions, 'pencil', `Редактировать: ${label}`);
		editButton.addEventListener('click', () => void this.editMetadataField(label, editOptions));
		const result = this.result || this.plugin.currentSource?.result;
		const canReset = !!(result?._originalMetadata && Object.prototype.hasOwnProperty.call(result._originalMetadata, editOptions.field));
		const resetButton = this.createIconButton(actions, 'rotate-ccw', `Вернуть стандартное значение: ${label}`);
		resetButton.disabled = !canReset;
		resetButton.addEventListener('click', () => void this.resetMetadataField(editOptions.field));
	}

	createIconButton(parent, icon, title) {
		const button = this.createElement(parent, 'button', { cls: 'scientific-source-field-action' });
		button.type = 'button';
		button.title = title;
		setIcon(button, icon);
		return button;
	}

	async editMetadataField(label, options) {
		const currentValue = cleanText(options.rawValue);
		new MetadataFieldEditModal(this.plugin.app, {
			label,
			value: currentValue,
			onSubmit: async (nextValue) => {
				await this.plugin.updateSourceMetadata(this.result || this.plugin.currentSource?.result, options.field, nextValue);
				new Notice('Поле источника обновлено.');
			}
		}).open();
	}

	async resetMetadataField(field) {
		await this.plugin.resetSourceMetadata(this.result || this.plugin.currentSource?.result, field);
		new Notice('Поле источника возвращено к стандартному значению.');
	}

	addUrlRow(parent, label, url) {
		const row = this.createElement(parent, 'div', { cls: 'scientific-source-details-row' });
		this.createElement(row, 'div', { cls: 'scientific-source-details-label', text: label });
		const cleanUrl = cleanText(url);
		if (!cleanUrl) {
			this.createElement(row, 'div', { cls: 'scientific-source-details-value', text: '—' });
			return;
		}
		const link = this.createElement(row, 'a', { cls: 'scientific-source-details-value scientific-source-details-link', text: cleanUrl });
		link.href = cleanUrl;
		link.addEventListener('click', (event) => {
			event.preventDefault();
			window.open(cleanUrl);
		});
	}

	createElement(parent, tag, options = {}) {
		const el = document.createElement(tag);
		if (options.cls) el.className = options.cls;
		if (options.text !== undefined) el.textContent = options.text;
		parent.appendChild(el);
		return el;
	}

	async openExternalPath(vaultPath) {
		const file = vaultPath ? this.app.vault.getAbstractFileByPath(vaultPath) : null;
		if (!file) return;
		const fullPath = path.join(this.app.vault.adapter.basePath, normalizePath(file.path));
		const error = await shell.openPath(fullPath);
		if (error) new Notice(`Не удалось открыть PDF: ${error}`);
	}

	async openPath(vaultPath) {
		const file = vaultPath ? this.app.vault.getAbstractFileByPath(vaultPath) : null;
		if (file) await this.app.workspace.getLeaf('tab').openFile(file);
	}

	async copyText(text, message = 'Скопировано.') {
		const value = cleanText(text);
		if (!value) return;
		await navigator.clipboard.writeText(value);
		new Notice(message);
	}

	hostFromUrl(value) {
		try {
			return new URL(value).host;
		} catch (error) {
			return '';
		}
	}
}

class MetadataFieldEditModal extends Modal {
	constructor(app, options) {
		super(app);
		this.options = options;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('scientific-source-edit-modal');
		contentEl.createEl('h3', { text: `Редактировать: ${this.options.label}` });
		this.inputEl = contentEl.createEl('textarea', {
			cls: 'scientific-source-edit-input'
		});
		this.inputEl.value = this.options.value || '';
		this.inputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				void this.submit();
			}
		});

		const actions = contentEl.createDiv({ cls: 'scientific-source-edit-actions' });
		const saveButton = actions.createEl('button', { text: 'Сохранить' });
		saveButton.addClass('mod-cta');
		saveButton.addEventListener('click', () => void this.submit());
		const cancelButton = actions.createEl('button', { text: 'Отмена' });
		cancelButton.addEventListener('click', () => this.close());

		window.setTimeout(() => {
			this.inputEl.focus();
			this.inputEl.select();
		}, 0);
	}

	async submit() {
		await this.options.onSubmit(this.inputEl.value);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

class SourceImportModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
		this.isImporting = false;
	}

	onOpen() {
		this.setTitle('Импортировать научный источник');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('scientific-source-importer-modal');

		contentEl.createEl('p', {
			text: 'Вставь URL страницы статьи или прямую ссылку на PDF. Плагин получит доступные метаданные, сохранит PDF и добавит источник в правую панель.'
		});

		this.inputEl = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'https://...'
		});
		this.inputEl.addClass('prompt-input');

		this.statusEl = contentEl.createDiv({ cls: 'scientific-source-importer-status' });
		this.statusEl.setText('Enter — начать импорт.');

		const buttonRow = contentEl.createDiv({ cls: 'scientific-source-importer-actions' });
		const importButton = buttonRow.createEl('button', { text: 'Импортировать' });
		importButton.addEventListener('click', () => void this.submit());

		this.inputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this.submit();
			}
		});

		window.setTimeout(() => this.inputEl.focus(), 50);
	}

	async submit() {
		if (this.isImporting) return;
		const url = cleanText(this.inputEl.value);
		if (!isSafeHttpUrl(url)) {
			this.statusEl.setText('Нужна обычная http/https-ссылка.');
			return;
		}

		this.isImporting = true;
		this.statusEl.setText('Импортирую источник...');
		try {
			const record = await this.plugin.importFromUrl(url);
			new Notice(`Источник импортирован: ${baseName(record.pdfPath) || record.title}`);
			this.close();
		} catch (error) {
			console.error(error);
			this.statusEl.setText(`Ошибка импорта: ${error.message}`);
		} finally {
			this.isImporting = false;
		}
	}
}

class SourceImporterSettingTab extends PluginSettingTab {
	constructor(app, plugin, defaults) {
		super(app, plugin);
		this.plugin = plugin;
		this.defaults = defaults;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Папка PDF')
			.setDesc('Куда сохранять найденные PDF.')
			.addText((text) =>
				text.setPlaceholder(this.defaults.sourceFilesDir).setValue(this.plugin.settings.sourceFilesDir).onChange(async (value) => {
					this.plugin.settings.sourceFilesDir = cleanText(value) || this.defaults.sourceFilesDir;
					await this.plugin.saveSettings();
					await this.plugin.cleanupMissingSources(false);
					this.plugin.refreshSourceDetailsViews();
				})
			);

		new Setting(containerEl)
			.setName('Открывать PDF и панель источника после импорта')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.openAfterImport).onChange(async (value) => {
					this.plugin.settings.openAfterImport = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Максимальный размер PDF, МБ')
			.setDesc('Защита от случайной загрузки слишком большого файла.')
			.addText((text) =>
				text.setPlaceholder(String(this.defaults.maxPdfMb)).setValue(String(this.plugin.settings.maxPdfMb)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.maxPdfMb = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 300) : this.defaults.maxPdfMb;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Папка Zotero')
			.setDesc('Оставь пустым для стандартной папки пользователя или укажи папку, где лежит zotero.sqlite.')
			.addText((text) =>
				text.setPlaceholder('%USERPROFILE%\\Zotero').setValue(this.plugin.settings.zoteroDir).onChange(async (value) => {
					this.plugin.settings.zoteroDir = cleanText(value);
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Путь к zotero.sqlite')
			.setDesc('Необязательно. Используется, если база Zotero лежит не в стандартном месте.')
			.addText((text) =>
				text.setPlaceholder('C:\\Users\\...\\Zotero\\zotero.sqlite').setValue(this.plugin.settings.zoteroDbPath).onChange(async (value) => {
					this.plugin.settings.zoteroDbPath = cleanText(value);
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Лимит импорта Zotero')
			.setDesc('Сколько последних записей Zotero с PDF просматривать за один импорт.')
			.addText((text) =>
				text.setPlaceholder(String(this.defaults.zoteroImportLimit)).setValue(String(this.plugin.settings.zoteroImportLimit)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.zoteroImportLimit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5000) : this.defaults.zoteroImportLimit;
					await this.plugin.saveSettings();
				})
			);
	}
}

class ScientificSourceImporterPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.citationOrderCache = new Map();
		this.sourceKeyIndexCache = null;
		this.loadInternalModules();
		this.importService = new ImportService(this.app, this.settings, requestUrl);
		this.zoteroImporter = new ZoteroImporter(this.app, this.settings, this.pluginDir);
		this.registerView(VIEW_TYPE_SOURCE_DETAILS, (leaf) => new SourceDetailsView(leaf, this));
		this.registerEditorExtension(createCitationExtension());
		this.registerMarkdownPostProcessor((el, context) => this.replaceRenderedCitations(el, context));
		this.addSettingTab(new SourceImporterSettingTab(this.app, this, DEFAULT_SETTINGS));

		this.addCommand({
			id: 'import-scientific-source-from-url',
			name: 'Импортировать научный источник по URL/PDF',
			callback: () => new SourceImportModal(this.app, this).open()
		});

		this.addCommand({
			id: 'show-imported-scientific-sources',
			name: 'Показать импортированные научные источники',
			callback: () => void this.openSourceList()
		});

		this.addCommand({
			id: 'show-current-note-scientific-sources',
			name: 'Показать источники текущей заметки',
			callback: () => void this.openCurrentNoteCitations()
		});

		this.addCommand({
			id: 'import-scientific-sources-from-zotero',
			name: 'Импортировать источники из Zotero',
			callback: () => void this.importFromZotero()
		});

		this.addCommand({
			id: 'cleanup-missing-scientific-sources',
			name: 'Очистить отсутствующие импортированные источники',
			callback: () => void this.cleanupMissingSources(true)
		});

		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file?.path) this.citationOrderCache.delete(file.path);
			if (file?.path) void this.removeImportedSourceByPath(file.path);
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (oldPath) this.citationOrderCache.delete(oldPath);
			if (file?.path && oldPath) void this.renameImportedSourcePath(oldPath, file.path);
		}));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		let changed = false;
		for (const key of ['sourceFilesDir']) {
			if (this.settings[key] === LEGACY_SETTINGS[key]) {
				this.settings[key] = DEFAULT_SETTINGS[key];
				changed = true;
			}
		}
		if (Object.prototype.hasOwnProperty.call(this.settings, 'sourceNotesDir')) {
			delete this.settings.sourceNotesDir;
			changed = true;
		}
		if (Array.isArray(this.settings.importedSources)) {
			const migrated = this.settings.importedSources.map((source) => {
				const next = Object.assign({}, source);
				delete next.sourceNotePath;
				if (next.result) {
					next.result = Object.assign({}, next.result);
					delete next.result.sourceNotePath;
				}
				return next;
			});
			if (JSON.stringify(migrated) !== JSON.stringify(this.settings.importedSources)) {
				this.settings.importedSources = migrated;
				changed = true;
			}
		}
		if (changed) await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.sourceKeyIndexCache = null;
		if (this.importService) this.importService.settings = this.settings;
		if (this.zoteroImporter) this.zoteroImporter.settings = this.settings;
	}

	async importFromUrl(rawUrl) {
		const result = await this.importService.importFromUrl(rawUrl);
		const record = await this.rememberImportedSource(result);
		this.currentSource = { result: record.result };
		if (this.settings.openAfterImport) await this.openImportedSource(record.result);
		return record;
	}

	async importFromZotero(options = {}) {
		if (!options.silent) new Notice('Импортирую источники из Zotero...');
		const existing = Array.isArray(this.settings.importedSources) ? this.settings.importedSources : [];
		const imported = await this.zoteroImporter.importAll({
			limit: options.limit,
			existingSources: existing
		});
		const records = [];
		for (const result of imported.results) {
			records.push(await this.rememberImportedSource(result));
		}
		await this.cleanupMissingSources(false);
		await this.openSourceList();
		const skipped = imported.skipped.length;
		if (!options.silent) {
			new Notice(`Импорт Zotero завершён: ${records.length}; пропущено: ${skipped}.`);
		}
		return { records, skipped: imported.skipped };
	}

	async rememberImportedSource(result) {
		const metadata = result?.metadata || {};
		const authors = formatAuthors(metadata.authors).join(', ');
		const year = cleanText(metadata.year || yearFromDate(metadata.date));
		const existing = this.settings.importedSources || [];
		const incomingIdentity = this.recordIdentity({
			zoteroKey: cleanText(metadata.zoteroKey),
			pdfPath: result.pdfPath || '',
			sourceUrl: result.sourceUrl || '',
			title: cleanText(metadata.title) || baseName(result.pdfPath) || 'Источник',
			year,
			result
		});
		const previous = existing.find((item) => this.recordIdentity(item) === incomingIdentity);
		const record = {
			id: previous?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			title: cleanText(metadata.title) || baseName(result.pdfPath) || 'Источник',
			authors,
			year,
			publicationTitle: cleanText(metadata.publicationTitle),
			sourceUrl: result.sourceUrl || '',
			pdfPath: result.pdfPath || '',
			zoteroKey: cleanText(metadata.zoteroKey),
			citationKey: cleanText(metadata.citationKey),
			importedAt: previous?.importedAt || new Date().toISOString(),
			lastUsedAt: previous?.lastUsedAt || '',
			result
		};
		const key = this.recordIdentity(record);
		this.settings.importedSources = [
			record,
			...existing.filter((item) => this.recordIdentity(item) !== key)
		].slice(0, 200);
		await this.saveSettings();
		return record;
	}

	recordIdentity(record) {
		const zoteroKey = cleanText(record.zoteroKey || record.result?.metadata?.zoteroKey);
		if (zoteroKey) return `zotero:${zoteroKey}`;
		return record.pdfPath || record.sourceUrl || `${record.title}-${record.year}`;
	}

	async updateSourceMetadata(result, field, value) {
		if (!result?.metadata || !field) return;
		this.ensureOriginalMetadataValue(result, field);
		this.assignMetadataField(result, field, value);
		this.syncImportedSourceFromResult(result);
		await this.saveSettings();
		this.refreshSourceDetailsViews();
	}

	async resetSourceMetadata(result, field) {
		if (!result?.metadata || !field) return;
		const original = result._originalMetadata || {};
		if (!Object.prototype.hasOwnProperty.call(original, field)) return;
		this.assignMetadataField(result, field, Object.prototype.hasOwnProperty.call(original, field) ? original[field] : '');
		this.syncImportedSourceFromResult(result);
		await this.saveSettings();
		this.refreshSourceDetailsViews();
	}

	ensureOriginalMetadataValue(result, field) {
		result._originalMetadata = result._originalMetadata || {};
		if (Object.prototype.hasOwnProperty.call(result._originalMetadata, field)) return;
		result._originalMetadata[field] = this.metadataFieldValue(result, field);
	}

	metadataFieldValue(result, field) {
		if (field === 'doi') return result.doi || result.metadata?.doi || '';
		const value = result.metadata?.[field];
		return Array.isArray(value) ? value.join(', ') : cleanText(value);
	}

	assignMetadataField(result, field, value) {
		const metadata = result.metadata || {};
		const cleanValue = cleanText(value);
		if (field === 'authors') {
			metadata.authors = cleanValue.split(/\s*[,;]\s*/).map(cleanText).filter(Boolean);
		} else {
			metadata[field] = cleanValue;
		}
		if (field === 'doi') result.doi = cleanValue;
		if (field === 'date') metadata.year = yearFromDate(cleanValue) || metadata.year || '';
		result.metadata = metadata;
	}

	syncImportedSourceFromResult(result) {
		const sources = Array.isArray(this.settings.importedSources) ? this.settings.importedSources : [];
		const key = this.recordIdentity({
			zoteroKey: result.metadata?.zoteroKey,
			pdfPath: result.pdfPath,
			sourceUrl: result.sourceUrl,
			title: result.metadata?.title,
			year: result.metadata?.year,
			result
		});
		for (const source of sources) {
			if (source.result !== result && this.recordIdentity(source) !== key) continue;
			source.result = result;
			source.title = cleanText(result.metadata?.title) || source.title;
			source.authors = formatAuthors(result.metadata?.authors).join(', ');
			source.year = cleanText(result.metadata?.year || yearFromDate(result.metadata?.date));
			source.publicationTitle = cleanText(result.metadata?.publicationTitle);
			source.sourceUrl = result.sourceUrl || source.sourceUrl;
			source.pdfPath = result.pdfPath || source.pdfPath;
			source.zoteroKey = cleanText(result.metadata?.zoteroKey || source.zoteroKey);
			source.citationKey = cleanText(result.metadata?.citationKey || source.citationKey);
		}
	}

	async cleanupMissingSources(notify = false) {
		const sources = Array.isArray(this.settings.importedSources) ? this.settings.importedSources : [];
		const existing = sources.filter((source) => !source.pdfPath || this.app.vault.getAbstractFileByPath(source.pdfPath));
		const removed = sources.length - existing.length;
		if (removed > 0) {
			this.settings.importedSources = existing;
			await this.saveSettings();
		}
		if (notify) new Notice(removed ? `Удалено отсутствующих источников: ${removed}` : 'Отсутствующих источников нет.');
		return removed;
	}

	async removeImportedSourceByPath(vaultPath) {
		const normalized = cleanText(vaultPath);
		if (!normalized) return 0;
		const sources = Array.isArray(this.settings.importedSources) ? this.settings.importedSources : [];
		const existing = sources.filter((source) => source.pdfPath !== normalized && source.result?.pdfPath !== normalized);
		const removed = sources.length - existing.length;
		if (removed > 0) {
			this.settings.importedSources = existing;
			await this.saveSettings();
			this.refreshSourceDetailsViews();
		}
		return removed;
	}

	async renameImportedSourcePath(oldPath, newPath) {
		const oldNormalized = cleanText(oldPath);
		const newNormalized = cleanText(newPath);
		if (!oldNormalized || !newNormalized) return false;
		let changed = false;
		const sources = (Array.isArray(this.settings.importedSources) ? this.settings.importedSources : []).map((source) => {
			if (source.pdfPath !== oldNormalized && source.result?.pdfPath !== oldNormalized) return source;
			changed = true;
			const next = Object.assign({}, source, { pdfPath: newNormalized });
			next.result = Object.assign({}, source.result || {}, { pdfPath: newNormalized });
			return next;
		});
		if (changed) {
			this.settings.importedSources = sources;
			await this.saveSettings();
			this.refreshSourceDetailsViews();
		}
		return changed;
	}

	refreshSourceDetailsViews() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_SOURCE_DETAILS)
			.forEach((leaf) => leaf.view instanceof SourceDetailsView && leaf.view.render());
	}

	async openImportedRecord(record) {
		await this.markRecordUsed(record);
		const result = this.recordToResult(record);
		this.currentSource = { result };
		await this.openImportedSource(result);
	}

	async openImportedRecordDetails(record) {
		await this.markRecordUsed(record);
		const result = this.recordToResult(record);
		this.currentSource = { result };
		await this.openSourceDetails(result);
	}

	recordToResult(record) {
		const result = record?.result || {};
		result.pdfPath = result.pdfPath || record?.pdfPath || '';
		result.sourceUrl = result.sourceUrl || record?.sourceUrl || '';
		result.metadata = result.metadata || {
			title: record?.title || '',
			authors: record?.authors ? [record.authors] : [],
			year: record?.year || '',
			publicationTitle: record?.publicationTitle || ''
		};
		return result;
	}

	async openRecordPdfInNewTab(record) {
		await this.markRecordUsed(record);
		const result = this.recordToResult(record);
		await this.openPdfInNewTab(result.pdfPath);
	}

	async markRecordUsed(record) {
		const key = this.recordIdentity(record || {});
		if (!key) return;
		const now = Date.now();
		const nextLastUsedAt = new Date(now).toISOString();
		let changed = false;
		this.settings.importedSources = (this.settings.importedSources || []).map((source) => {
			if (this.recordIdentity(source) !== key) return source;
			const previous = Date.parse(cleanText(source.lastUsedAt));
			if (Number.isFinite(previous) && now - previous < LAST_USED_SAVE_INTERVAL_MS) return source;
			changed = true;
			return Object.assign({}, source, { lastUsedAt: nextLastUsedAt });
		});
		if (changed) await this.saveSettings();
	}

	async openImportedSource(result) {
		if (result?.pdfPath) await this.openPdfInNewTab(result.pdfPath);
		await this.openSourceDetails(result);
	}

	async openSourceDetails(result) {
		await this.cleanupRightSidebarArtifacts();
		const leaf = await this.getSourceDetailsLeaf();
		if (!leaf) return;
		if (leaf.view instanceof SourceDetailsView) {
			leaf.view.setSource(result);
		}
		this.activateRightLeaf(leaf);
	}

	async openPdfInNewTab(vaultPath) {
		const file = vaultPath ? this.app.vault.getAbstractFileByPath(vaultPath) : null;
		if (!file) {
			new Notice('PDF-оригинал не найден.');
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(file);
		if (typeof this.app.workspace.setActiveLeaf === 'function') {
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		} else if (typeof this.app.workspace.focusLeaf === 'function') {
			this.app.workspace.focusLeaf(leaf);
		}
	}

	async openSourceList() {
		await this.cleanupMissingSources(false);
		await this.cleanupRightSidebarArtifacts();
		const leaf = await this.getSourceDetailsLeaf();
		if (!leaf) return;
		if (leaf.view instanceof SourceDetailsView) leaf.view.showList();
		this.activateRightLeaf(leaf);
	}

	async openCurrentNoteCitations() {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice('Открой Markdown-заметку с ключами вида [@ключ].');
			return;
		}

		const citeKeys = Array.from((await this.getCitationOrderForFile(file)).keys());
		await this.cleanupRightSidebarArtifacts();
		const leaf = await this.getSourceDetailsLeaf();
		if (!leaf) return;
		if (leaf.view instanceof SourceDetailsView) {
			leaf.view.showNoteCitations(file, citeKeys, this.buildCitationResult(citeKeys));
		}
		this.activateRightLeaf(leaf);
	}

	async showCitationsInView(view) {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice('Открой Markdown-заметку с ключами вида [@ключ].');
			return;
		}
		const citeKeys = Array.from((await this.getCitationOrderForFile(file)).keys());
		view.showNoteCitations(file, citeKeys, this.buildCitationResult(citeKeys));
	}

	getActiveMarkdownFile() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file || this.app.workspace.getActiveFile();
		return file?.extension === 'md' ? file : null;
	}

	buildCitationResult(citeKeys) {
		const references = [];
		const unresolved = [];
		for (let index = 0; index < citeKeys.length; index += 1) {
			const key = citeKeys[index];
			const record = this.findImportedSourceByKey(key);
			if (!record) {
				unresolved.push(key);
				continue;
			}
			references.push({
				key,
				number: index + 1,
				record,
				text: this.buildRecordReference(record)
			});
		}
		return { references, unresolved };
	}

	findImportedSourceByKey(key) {
		const wanted = cleanText(key);
		if (!wanted) return null;
		return this.getSourceKeyIndex().get(wanted) || null;
	}

	getSourceKeyIndex() {
		const sources = this.settings.importedSources || [];
		if (this.sourceKeyIndexCache?.sources === sources) return this.sourceKeyIndexCache.index;
		const index = new Map();
		for (const record of sources) {
			for (const key of this.sourceCitationKeys(record)) {
				if (!index.has(key)) index.set(key, record);
			}
		}
		this.sourceKeyIndexCache = { sources, index };
		return index;
	}

	sourceCitationKeys(record) {
		return [
			record?.citationKey,
			record?.zoteroKey,
			record?.id,
			record?.result?.metadata?.citationKey,
			record?.result?.metadata?.zoteroKey
		].map(cleanText).filter(Boolean);
	}

	buildRecordReference(record) {
		const result = record?.result || {};
		const metadata = result.metadata || {};
		const year = cleanText(metadata.year || record?.year || yearFromDate(metadata.date));
		const reference = buildReference ? buildReference(Object.assign({}, metadata, { year }), result.sourceUrl || record?.sourceUrl) : '';
		return cleanText(reference) || [record?.authors, record?.title, year].map(cleanText).filter(Boolean).join(' ');
	}

	async replaceRenderedCitations(el, context) {
		const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
		if (!file?.path) return;

		const citeOrder = await this.getCitationOrderForFile(file);
		if (citeOrder.size === 0) return;

		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const nodes = [];
		while (walker.nextNode()) {
			const node = walker.currentNode;
			const parent = node.parentElement;
			if (!parent || parent.closest('code, pre, .scientific-source-details')) continue;
			nodes.push(node);
		}

		for (const textNode of nodes) {
			const text = textNode.nodeValue || '';
			if (!text.includes('[@')) continue;
			const fragment = document.createDocumentFragment();
			let lastIndex = 0;
			let changed = false;
			let match;
			while ((match = CITE_PATTERN.exec(text)) !== null) {
				const key = match[1];
				const number = citeOrder.get(key);
				if (!number) continue;
				changed = true;
				if (match.index > lastIndex) {
					fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
				}
				const span = document.createElement('span');
				span.className = 'scientific-source-inline-cite';
				span.textContent = `[${number}]`;
				span.title = key;
				fragment.appendChild(span);
				lastIndex = match.index + match[0].length;
			}
			CITE_PATTERN.lastIndex = 0;
			if (!changed) continue;
			if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
			textNode.replaceWith(fragment);
		}
	}

	async getCitationOrderForFile(file) {
		const mtime = file.stat?.mtime || 0;
		const cached = this.citationOrderCache.get(file.path);
		if (cached?.mtime === mtime) return cached.order;
		const content = await this.app.vault.cachedRead(file);
		const order = collectCitationOrder(content);
		this.citationOrderCache.set(file.path, { mtime, order });
		if (this.citationOrderCache.size > CITATION_ORDER_CACHE_LIMIT) {
			const oldestKey = this.citationOrderCache.keys().next().value;
			this.citationOrderCache.delete(oldestKey);
		}
		return order;
	}

	async getSourceDetailsLeaf() {
		if (typeof this.app.workspace.ensureSideLeaf === 'function') {
			return this.app.workspace.ensureSideLeaf(VIEW_TYPE_SOURCE_DETAILS, 'right', {
				active: true,
				reveal: true,
				split: false
			});
		}
		const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getRightLeaf(true);
		if (leaf) await leaf.setViewState({ type: VIEW_TYPE_SOURCE_DETAILS, active: true });
		return leaf;
	}

	async cleanupRightSidebarArtifacts() {
		if (typeof this.app.workspace.detachLeavesOfType === 'function') {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_SOURCE_DETAILS);
		}
		const leaves = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const inRightSidebar = !!leaf.containerEl?.closest?.('.workspace-split.mod-right-split');
			const viewType = leaf.view?.getViewType?.();
			if (inRightSidebar && viewType === 'empty') leaves.push(leaf);
		});
		for (const leaf of leaves) await leaf.detach();
	}

	activateRightLeaf(leaf) {
		this.app.workspace.revealLeaf(leaf);
		this.ensureSourcePanelWidth(leaf);
		if (typeof this.app.workspace.setActiveLeaf === 'function') {
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		} else if (typeof this.app.workspace.focusLeaf === 'function') {
			this.app.workspace.focusLeaf(leaf);
		}
	}

	ensureSourcePanelWidth(leaf) {
		const split = leaf?.containerEl?.closest?.('.workspace-split.mod-right-split');
		if (!split) return;
		const currentWidth = split.getBoundingClientRect().width;
		if (currentWidth >= SOURCE_PANEL_MIN_WIDTH) return;
		split.style.width = `${SOURCE_PANEL_MIN_WIDTH}px`;
		split.style.minWidth = `${SOURCE_PANEL_MIN_WIDTH}px`;
		window.dispatchEvent(new Event('resize'));
	}

	loadInternalModules() {
		this.pluginDir = path.join(this.app.vault.adapter.basePath, this.manifest.dir);
		({ ImportService } = require(path.join(this.pluginDir, 'import-service.js')));
		({ ZoteroImporter } = require(path.join(this.pluginDir, 'zotero-importer.js')));
		({ buildReference } = require(path.join(this.pluginDir, 'reference.js')));
	}
}

module.exports = ScientificSourceImporterPlugin;
