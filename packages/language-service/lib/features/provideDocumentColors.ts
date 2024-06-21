import { isColorEnabled } from '@volar/language-core';
import type * as vscode from 'vscode-languageserver-protocol';
import type { URI } from 'vscode-uri';
import type { LanguageServiceContext } from '../types';
import { NoneCancellationToken } from '../utils/cancellation';
import { documentFeatureWorker } from '../utils/featureWorkers';

export function register(context: LanguageServiceContext) {

	return (uri: URI, token = NoneCancellationToken) => {

		return documentFeatureWorker(
			context,
			uri,
			map => map.map.mappings.some(mapping => isColorEnabled(mapping.data)),
			(plugin, document) => {
				if (token.isCancellationRequested) {
					return;
				}
				return plugin[1].provideDocumentColors?.(document, token);
			},
			(data, map) => {
				if (!map) {
					return data;
				}
				return data
					.map<vscode.ColorInformation | undefined>(color => {
						const range = map.getSourceRange(color.range, isColorEnabled);
						if (range) {
							return {
								range,
								color: color.color,
							};
						}
					})
					.filter(color => !!color);
			},
			arr => arr.flat()
		);
	};
}
