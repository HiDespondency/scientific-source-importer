'use strict';

const { decodeHtml, isSafeHttpUrl, normalizeDoi, normalizePages, yearFromDate } = require('./utils');
const { namedMetaContent, namedMetaContents } = require('./html-metadata');

function extractEprintsMetadata(html) {
	const eprintsDate = namedMetaContent(html, 'eprints.date');
	const authors = namedMetaContents(html, 'eprints.creators_name');
	const abstracts = namedMetaContents(html, 'eprints.abstract');
	return {
		title: namedMetaContent(html, 'eprints.title'),
		authors,
		publicationTitle: namedMetaContent(html, 'eprints.publication'),
		date: eprintsDate,
		year: yearFromDate(eprintsDate),
		volume: namedMetaContent(html, 'eprints.volume'),
		issue: namedMetaContent(html, 'eprints.number'),
		pages: normalizePages(namedMetaContent(html, 'eprints.pagerange')),
		doi: namedMetaContent(html, 'eprints.id_number') || normalizeDoi(namedMetaContent(html, 'eprints.citation')),
		issn: namedMetaContent(html, 'eprints.issn'),
		eissn: namedMetaContent(html, 'eprints.eissn'),
		isbn: namedMetaContent(html, 'eprints.isbn'),
		udc: namedMetaContent(html, 'eprints.udc'),
		lccn: namedMetaContent(html, 'eprints.lccn'),
		pmid: namedMetaContent(html, 'eprints.pmid'),
		pmcid: namedMetaContent(html, 'eprints.pmcid'),
		arxiv: namedMetaContent(html, 'eprints.arxiv'),
		url: namedMetaContent(html, 'eprints.document_url'),
		publisher: namedMetaContent(html, 'eprints.publisher'),
		place: namedMetaContent(html, 'eprints.place_of_pub'),
		sourceType: namedMetaContent(html, 'eprints.type'),
		refereed: namedMetaContent(html, 'eprints.refereed'),
		keywords: namedMetaContent(html, 'eprints.keywords'),
		abstract: abstracts.length ? abstracts[abstracts.length - 1] : '',
		citation: namedMetaContent(html, 'eprints.citation')
	};
}

function findCyberleninkaPdfUrl(html, baseUrl) {
	const pattern = /href=["']([^"']*\/article\/n\/[^"']+\/pdf)["']/i;
	const match = pattern.exec(html);
	if (!match) return '';
	try {
		const absolute = new URL(decodeHtml(match[1]), baseUrl).toString();
		return isSafeHttpUrl(absolute) ? absolute : '';
	} catch (error) {
		return '';
	}
}

function applyCyberleninkaMetadata(result, html, mergeMetadata) {
	let host = '';
	try {
		host = new URL(result.sourceUrl).hostname.toLowerCase();
	} catch (error) {
		return;
	}
	if (!host.includes('cyberleninka.ru')) return;
	result.provenance.push('правила CyberLeninka');
	result.metadata = mergeMetadata(result.metadata, extractEprintsMetadata(html));
	result.metadata.url = result.metadata.url || result.sourceUrl;
	result.pdfUrl = result.pdfUrl || findCyberleninkaPdfUrl(html, result.sourceUrl);
}

module.exports = {
	applyCyberleninkaMetadata,
	findCyberleninkaPdfUrl
};
