'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { normalizeDoi } = require('./utils');

const execFileAsync = promisify(execFile);
const PDFINFO_EXE = 'pdfinfo';
const PDFTOTEXT_EXE = 'pdftotext';
const EDGE_PAGE_COUNT = 3;

async function extractDoiFromLocalPdf(pdfPath) {
	const firstPagesText = await extractPdfTextRange(pdfPath, 1, EDGE_PAGE_COUNT);
	const firstPagesDoi = normalizeDoi(firstPagesText);
	if (firstPagesDoi) return { doi: firstPagesDoi, method: 'текстовый слой PDF: первые страницы' };

	const pageCount = await getPdfPageCount(pdfPath);
	if (!pageCount || pageCount <= EDGE_PAGE_COUNT) return { doi: '', method: '' };
	const tailText = await extractPdfTextRange(pdfPath, Math.max(EDGE_PAGE_COUNT + 1, pageCount - EDGE_PAGE_COUNT + 1), pageCount);
	const citationDoi = extractDoiFromCitationContext(tailText);
	return citationDoi ? { doi: citationDoi, method: 'текстовый слой PDF: блок цитирования в конце' } : { doi: '', method: '' };
}

async function extractEdgeTextFromPdf(pdfPath) {
	const pageCount = await getPdfPageCount(pdfPath);
	const ranges = edgePageRanges(pageCount);
	const parts = [];
	for (const [first, last] of ranges) {
		const text = await extractPdfTextRange(pdfPath, first, last);
		if (text) parts.push(text);
	}
	return parts.join('\n\n');
}

async function getPdfPageCount(pdfPath) {
	try {
		const { stdout } = await execFileAsync(PDFINFO_EXE, [pdfPath], {
			windowsHide: true,
			maxBuffer: 1024 * 1024,
			timeout: 10000
		});
		const match = String(stdout || '').match(/^Pages:\s+(\d+)/im);
		const pages = match ? Number.parseInt(match[1], 10) : 0;
		return Number.isFinite(pages) && pages > 0 ? pages : 0;
	} catch (error) {
		return 0;
	}
}

function edgePageRanges(pageCount) {
	if (!pageCount) return [[1, EDGE_PAGE_COUNT]];
	const firstLast = Math.min(EDGE_PAGE_COUNT, pageCount);
	const ranges = [[1, firstLast]];
	const tailFirst = Math.max(firstLast + 1, pageCount - EDGE_PAGE_COUNT + 1);
	if (tailFirst <= pageCount) ranges.push([tailFirst, pageCount]);
	return ranges;
}

async function extractPdfTextRange(pdfPath, first, last) {
	try {
		const { stdout } = await execFileAsync(PDFTOTEXT_EXE, ['-f', String(first), '-l', String(last), '-layout', pdfPath, '-'], {
			windowsHide: true,
			maxBuffer: 3 * 1024 * 1024,
			timeout: 20000
		});
		return String(stdout || '');
	} catch (error) {
		return '';
	}
}

function extractDoiFromCitationContext(text) {
	const lines = String(text || '').split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		if (!/(для\s+цитирования|как\s+цитировать|for\s+citation|to\s+cite|citation)/i.test(lines[index])) continue;
		const block = lines.slice(index, index + 8).join(' ');
		const doi = normalizeDoi(block);
		if (doi) return doi;
	}
	return '';
}

module.exports = {
	extractDoiFromLocalPdf,
	extractEdgeTextFromPdf
};
