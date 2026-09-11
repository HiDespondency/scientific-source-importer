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

function firstMatch(text, pattern) {
	const match = pattern.exec(String(text || ''));
	return match ? String(match[1] || '').replace(/\s+/g, ' ').trim() : '';
}

function extractIdentifiersFromText(text) {
	const value = String(text || '').replace(/\u00ad/g, ' ');
	const udc = firstMatch(value, /(?:УДК|UDC)\s*[:.]?\s*([0-9]{1,3}(?:\.[0-9]+)*(?:\s*;\s*[0-9]{1,3}(?:\.[0-9]+)*)*)/i);
	const isbn = firstMatch(value, /ISBN(?:-1[03])?\s*[:.]?\s*([0-9][0-9Xx -]{8,})/i).replace(/\s+/g, ' ').trim();
	const eissn = firstMatch(value, /eISSN\s*[:.]?\s*([0-9]{4}[- ]?[0-9]{3}[0-9Xx])/i);
	const issn = firstMatch(value, /(?:^|\s)ISSN\s*[:.]?\s*([0-9]{4}[- ]?[0-9]{3}[0-9Xx])/im);
	const pmid = firstMatch(value, /PMID\s*[:.]?\s*(\d{5,})/i);
	const pmcid = firstMatch(value, /PMCID\s*[:.]?\s*(PMC\d+)/i);
	const arxiv = firstMatch(value, /arXiv\s*[:.]?\s*([0-9]{4}\.\d{4,5}(?:v\d+)?)/i);
	return { doi: normalizeDoi(value), udc, isbn, eissn, issn, pmid, pmcid, arxiv };
}

function compactPdfText(value) {
	return String(value || '')
		.replace(/\u00ad/g, ' ')
		.replace(/([A-Za-zА-Яа-яЁё])-\s+([A-Za-zА-Яа-яЁё])/g, '$1$2')
		.replace(/[ \t]+/g, ' ')
		.replace(/\s*\n\s*/g, ' ')
		.trim();
}

function extractKeywordsFromText(text) {
	const value = String(text || '').replace(/\u00ad/g, ' ').split('\f')[0];
	const match = value.match(/(?:Ключевые\s+слова|Keywords)\s*:\s*([\s\S]{1,1200}?)(?=\n\s*(?:Для\s+цитирования|For\s+citation|Введение|Introduction|Аннотация|Abstract)\b|\n\s*\n|$)/i);
	return match ? compactPdfText(match[1]).replace(/[.;]+$/, '').trim() : '';
}

function extractAbstractFromText(text) {
	const value = String(text || '').replace(/\u00ad/g, ' ');
	const match = value.match(/(?:Аннотация|Abstract)\s*:\s*([\s\S]{1,5000}?)(?=\n\s*(?:Ключевые\s+слова|Keywords|Для\s+цитирования|For\s+citation|Введение|Introduction)\b|\n\s*\n|$)/i);
	return match ? compactPdfText(match[1]) : '';
}

function extractAuthorsFromText(text) {
	const value = String(text || '').replace(/\u00ad/g, ' ').split('\f')[0];
	const authors = [];
	for (const match of value.matchAll(/©\s*([^\n]+)/g)) {
		const author = String(match[1] || '')
			.replace(/\s*[\d¹²³⁴⁵⁶⁷⁸⁹]+(?:\s*[,;]?[a-z])?\s*$/i, '')
			.replace(/\s*[,;]+\s*$/, '')
			.trim();
		if (author && !authors.includes(author)) authors.push(author);
	}
	return authors;
}

function extractCitationMetadataFromText(text) {
	const value = String(text || '').replace(/\u00ad/g, ' ');
	const blockMatch = value.match(/(?:Для\s+цитирования|For\s+citation)\s*:\s*([\s\S]{1,1400}?)(?=\n\s*\n|$)/i);
	const block = blockMatch ? compactPdfText(blockMatch[1]) : '';
	if (!block) return {};
	const publication = block.match(/\/\/\s*(.+?)\.\s*(\d{4})\./i) || block.match(/\.\s*([^.!?]+?)\.\s*(\d{4})\./i);
	const metadata = {};
	if (publication) {
		metadata.publicationTitle = compactPdfText(publication[1]);
		metadata.year = publication[2];
	}
	const volume = block.match(/(?:Т\.|Vol\.)\s*([\w-]+)/i);
	const issue = block.match(/(?:№|No\.)\s*([\w()\/-]+)/i);
	const pages = block.match(/(?:С\.|Pp?\.)\s*([\d–—-]+(?:\s*[-–—]\s*\d+)?)/i);
	if (volume) metadata.volume = volume[1];
	if (issue) metadata.issue = issue[1];
	if (pages) metadata.pages = pages[1].replace(/—/g, '–');
	return metadata;
}

function extractPdfMetadataFromText(text) {
	const value = String(text || '');
	const metadata = Object.assign({}, extractIdentifiersFromText(value), extractCitationMetadataFromText(value));
	const authors = extractAuthorsFromText(value);
	if (authors.length) metadata.authors = authors;
	const keywords = extractKeywordsFromText(value);
	if (keywords) metadata.keywords = keywords;
	const abstract = extractAbstractFromText(value);
	if (abstract) metadata.abstract = abstract;
	const grnti = firstMatch(value, /ГРНТИ\s*[:.]?\s*([0-9. -]+)/i);
	const edn = firstMatch(value, /\bEDN\s*[:.]?\s*([A-Z0-9-]+)/i);
	if (grnti) metadata.grnti = grnti.replace(/\s+/g, ' ').trim();
	if (edn) metadata.edn = edn;
	return metadata;
}

async function extractMetadataFromLocalPdf(pdfPath) {
	const text = await extractEdgeTextFromPdf(pdfPath);
	return extractPdfMetadataFromText(text);
}

async function extractIdentifiersFromLocalPdf(pdfPath) {
	const text = await extractEdgeTextFromPdf(pdfPath);
	return extractIdentifiersFromText(text);
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
	extractIdentifiersFromLocalPdf,
	extractMetadataFromLocalPdf,
	extractPdfMetadataFromText,
	extractEdgeTextFromPdf
};
