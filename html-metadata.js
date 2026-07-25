'use strict';

const {
	cleanText,
	decodeHtml,
	escapeRegex,
	normalizePageRange,
	yearFromDate
} = require('./utils');

function metaContent(html, names) {
	for (const name of names) {
		const escaped = escapeRegex(name);
		const direct = new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i').exec(html);
		if (direct) return decodeHtml(direct[1]);
		const reverse = new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, 'i').exec(html);
		if (reverse) return decodeHtml(reverse[1]);
	}
	return '';
}

function metaContents(html, names) {
	const values = [];
	for (const name of names) {
		const pattern = new RegExp(`<meta\\s+[^>]*(?:name|property)=["']${escapeRegex(name)}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'ig');
		let match;
		while ((match = pattern.exec(html)) !== null) values.push(decodeHtml(match[1]));
	}
	return [...new Set(values.map(cleanText).filter(Boolean))];
}

function namedMetaContent(html, name) {
	return metaContent(html, [name]);
}

function namedMetaContents(html, name) {
	return metaContents(html, [name]);
}

function extractHtmlMetadata(html) {
	const date = metaContent(html, ['citation_publication_date', 'citation_date', 'article:published_time', 'DC.Date', 'dc.date']);
	return {
		title: metaContent(html, ['citation_title', 'og:title', 'DC.title', 'dc.title']),
		authors: metaContents(html, ['citation_author', 'dc.creator', 'DC.creator', 'article:author']),
		publicationTitle: metaContent(html, ['citation_journal_title', 'citation_conference_title', 'citation_publisher', 'prism.publicationName']),
		date,
		year: yearFromDate(date),
		volume: metaContent(html, ['citation_volume', 'prism.volume']),
		issue: metaContent(html, ['citation_issue', 'prism.number']),
		pages: normalizePageRange(
			metaContent(html, ['citation_firstpage', 'prism.startingPage']),
			metaContent(html, ['citation_lastpage', 'prism.endingPage']),
			metaContent(html, ['citation_pages'])
		),
		doi: metaContent(html, ['citation_doi', 'DC.Identifier', 'dc.identifier', 'prism.doi']),
		issn: metaContent(html, ['citation_issn', 'prism.issn']),
		url: metaContent(html, ['citation_public_url', 'og:url'])
	};
}

module.exports = {
	extractHtmlMetadata,
	metaContent,
	namedMetaContent,
	namedMetaContents
};
