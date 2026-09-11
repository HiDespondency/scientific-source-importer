'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const utils = require(path.join(root, 'utils.js'));
const html = require(path.join(root, 'html-metadata.js'));
const pdf = require(path.join(root, 'pdf-metadata.js'));
const { ImportService } = require(path.join(root, 'import-service.js'));
const { AutonomousResolver } = require(path.join(root, 'autonomous-resolver.js'));

function fakeApp() {
	return { vault: { adapter: { basePath: 'C:/scientific-source-importer-test', exists: async () => false, writeBinary: async () => {} }, createFolder: async () => {}, createBinary: async () => {} } };
}

async function main() {
	for (const url of ['https://example.org/a', 'http://example.org/a']) assert.equal(utils.isSafeHttpUrl(url), true);
	for (const url of ['javascript:alert(1)', 'file:///C:/x.pdf', 'data:text/plain,x', 'ftp://example.org/a', 'not-a-url']) assert.equal(utils.isSafeHttpUrl(url), false);
	assert.equal(utils.normalizeDoi('https://doi.org/10.1234/ABC.'), '10.1234/ABC');
	assert.equal(utils.normalizePages('19-21'), '19–21');
	assert.ok(utils.bibliographicWarnings({ sourceType: 'journalArticle', title: 'T', authors: ['A'], publicationTitle: 'J', year: '2024', pages: '1–2', doi: '10.1037//0022' }).some((warning) => warning.includes('DOI')));
	assert.equal(html.extractHtmlMetadata('<meta name="citation_title" content="A Title"><meta name="citation_doi" content="10.1234/a">').doi, '10.1234/a');
	assert.equal(pdf.extractPdfMetadataFromText('DOI: 10.1234/abc\nISSN 1234-5678\nУДК 343.85').udc, '343.85');

	let crossrefCalls = 0;
	let retryCalls = 0;
	const service = new ImportService(fakeApp(), { sourceFilesDir: 'QA', maxPdfMb: 1 }, async ({ url }) => {
		if (url.includes('/retry')) {
			retryCalls += 1;
			if (retryCalls < 3) return { status: 503, headers: {} };
			return { status: 200, text: 'ok', headers: {} };
		}
		crossrefCalls += 1;
		return { status: 200, text: JSON.stringify({ message: { title: ['Test Article'], author: [{ given: 'Jane', family: 'Doe' }], issued: { 'date-parts': [[2024]] }, DOI: '10.1234/test' } }), headers: {} };
	});
	const first = await service.fetchCrossref('10.1234/test');
	const second = await service.fetchCrossref('10.1234/test');
	assert.equal(first.year, '2024');
	assert.deepEqual(first, second);
	assert.equal(crossrefCalls, 1);
	assert.equal((await service.fetchText('https://example.org/retry')).text, 'ok');
	assert.equal(retryCalls, 3);
	let notFoundCalls = 0;
	const notFoundService = new ImportService(fakeApp(), { sourceFilesDir: 'QA', maxPdfMb: 1 }, async () => {
		notFoundCalls += 1;
		return { status: 404, headers: {} };
	});
	await assert.rejects(() => notFoundService.fetchText('https://example.org/missing'), /HTTP 404/);
	assert.equal(notFoundCalls, 1);

	const invalidPdfService = new ImportService(fakeApp(), { sourceFilesDir: 'QA', maxPdfMb: 1 }, async () => ({ status: 200, arrayBuffer: new TextEncoder().encode('not pdf').buffer, headers: { 'content-type': 'text/html' }, finalUrl: 'https://example.org/fake.pdf' }));
	await assert.rejects(() => invalidPdfService.downloadPdf('https://example.org/fake.pdf', { title: 'Fake' }, ''), /ответ не похож на PDF/);

	const resolver = new AutonomousResolver({
		fetchCrossref: async () => ({ title: 'Other Article', doi: '10.1234/wrong', type: 'journal-article' }),
		fetchText: async (url) => url.startsWith('https://api.crossref.org/') ? { text: JSON.stringify({ message: { items: [{ title: ['Test Article'], DOI: '10.1234/test', type: 'journal-article', link: [{ URL: 'https://example.org/test.pdf', 'content-type': 'application/pdf' }] }] } }), finalUrl: url } : { text: '<title>Test Article</title>', finalUrl: 'https://example.org/article' },
		findPdfUrl: () => ''
	});
	const resolved = await resolver.enrich({ title: 'Test Article', doi: '10.1234/wrong' }, 'https://example.org/article');
	assert.equal(resolved.metadata.doi, '10.1234/test');
	assert.equal(resolved.pdfUrl, 'https://example.org/test.pdf');
	assert.ok(resolved.warnings.length > 0);
	console.log('scientific-source-importer tests: PASS');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
