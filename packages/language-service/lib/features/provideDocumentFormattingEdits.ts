import { CodeInformation, SourceMap, SourceScript, VirtualCode, forEachEmbeddedCode, isFormattingEnabled, updateVirtualCodeMapOfMap } from '@volar/language-core';
import type * as ts from 'typescript';
import type * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SourceMapWithDocuments } from '../documents';
import type { EmbeddedCodeFormattingOptions, ServiceContext } from '../types';
import { NoneCancellationToken } from '../utils/cancellation';
import { findOverlapCodeRange, stringToSnapshot } from '../utils/common';
import { getEmbeddedFilesByLevel as getEmbeddedCodesByLevel } from '../utils/featureWorkers';

export function register(context: ServiceContext) {

	let fakeVersion = 0;

	return async (
		uri: string,
		options: vscode.FormattingOptions,
		range: vscode.Range | undefined,
		onTypeParams: {
			ch: string,
			position: vscode.Position,
		} | undefined,
		token = NoneCancellationToken
	) => {

		const sourceScript = context.language.scripts.get(uri);
		if (!sourceScript) {
			return;
		}

		let document = context.documents.get(uri, sourceScript.languageId, sourceScript.snapshot);

		range ??= {
			start: document.positionAt(0),
			end: document.positionAt(document.getText().length),
		};

		if (!sourceScript.generated) {
			return onTypeParams
				? (await tryFormat(document, document, sourceScript, undefined, 0, onTypeParams.position, onTypeParams.ch))?.edits
				: (await tryFormat(document, document, sourceScript, undefined, 0, range, undefined))?.edits;
		}

		const embeddedRanges = new Map<string, { start: number, end: number; }>();
		const startOffset = document.offsetAt(range.start);
		const endOffset = document.offsetAt(range.end);

		for (const code of forEachEmbeddedCode(sourceScript.generated.root)) {
			const map = context.language.maps.get(code);
			if (map) {
				const embeddedRange = findOverlapCodeRange(startOffset, endOffset, map, isFormattingEnabled);
				if (embeddedRange) {
					if (embeddedRange.start === map.mappings[0].generatedOffsets[0]) {
						embeddedRange.start = 0;
					}
					const lastMapping = map.mappings[map.mappings.length - 1];
					if (embeddedRange.end === lastMapping.generatedOffsets[lastMapping.generatedOffsets.length - 1] + lastMapping.lengths[lastMapping.lengths.length - 1]) {
						embeddedRange.end = code.snapshot.getLength();
					}
					embeddedRanges.set(code.id, embeddedRange);
				}
			}
		}

		try {
			const originalDocument = document;

			let tempSourceSnapshot = sourceScript.snapshot;
			let tempVirtualFile = context.language.scripts.set(sourceScript.id + '.tmp', sourceScript.snapshot, sourceScript.languageId, [sourceScript.generated.languagePlugin])?.generated?.root;
			if (!tempVirtualFile) {
				return;
			}

			let level = 0;

			while (true) {

				const embeddedCodes = getEmbeddedCodesByLevel(context, sourceScript.id, tempVirtualFile, level++);
				if (embeddedCodes.length === 0) {
					break;
				}

				let edits: vscode.TextEdit[] = [];

				for (const code of embeddedCodes) {

					if (!code.mappings.some(mapping => isFormattingEnabled(mapping.data))) {
						continue;
					}

					const docMap = createDocMap(code, uri, sourceScript.languageId, tempSourceSnapshot);
					if (!docMap) {
						continue;
					}

					let embeddedCodeResult: Awaited<ReturnType<typeof tryFormat>> | undefined;
					let embeddedRange = embeddedRanges.get(code.id);

					if (onTypeParams) {

						const embeddedPosition = docMap.getGeneratedPosition(onTypeParams.position);

						if (embeddedPosition) {
							embeddedCodeResult = await tryFormat(
								docMap.sourceDocument,
								docMap.embeddedDocument,
								sourceScript,
								code,
								level,
								embeddedPosition,
								onTypeParams.ch,
							);
						}
					}
					else if (embeddedRange) {
						embeddedCodeResult = await tryFormat(
							docMap.sourceDocument,
							docMap.embeddedDocument,
							sourceScript,
							code,
							level,
							{
								start: docMap.embeddedDocument.positionAt(embeddedRange.start),
								end: docMap.embeddedDocument.positionAt(embeddedRange.end),
							},
						);
					}

					if (!embeddedCodeResult) {
						continue;
					}

					for (const textEdit of embeddedCodeResult.edits) {
						const range = docMap.getSourceRange(textEdit.range);
						if (range) {
							edits.push({
								newText: textEdit.newText,
								range,
							});
						}
					}
				}

				if (edits.length > 0) {
					const newText = TextDocument.applyEdits(document, edits);
					document = TextDocument.create(document.uri, document.languageId, document.version + 1, newText);
					tempSourceSnapshot = stringToSnapshot(newText);
					tempVirtualFile = context.language.scripts.set(sourceScript.id + '.tmp', tempSourceSnapshot, sourceScript.languageId, [sourceScript.generated.languagePlugin])?.generated?.root;
					if (!tempVirtualFile) {
						break;
					}
				}
			}

			if (document.getText() === originalDocument.getText()) {
				return;
			}

			const editRange: vscode.Range = {
				start: originalDocument.positionAt(0),
				end: originalDocument.positionAt(originalDocument.getText().length),
			};
			const textEdit: vscode.TextEdit = {
				range: editRange,
				newText: document.getText(),
			};

			return [textEdit];
		} finally {
			context.language.scripts.delete(sourceScript.id + '.tmp');
		}

		async function tryFormat(
			sourceDocument: TextDocument,
			document: TextDocument,
			sourceScript: SourceScript,
			virtualCode: VirtualCode | undefined,
			embeddedLevel: number,
			rangeOrPosition: vscode.Range | vscode.Position,
			ch?: string,
		) {

			if (context.disabledEmbeddedDocumentUris.has(document.uri)) {
				return;
			}

			let codeOptions: EmbeddedCodeFormattingOptions | undefined;

			rangeOrPosition ??= {
				start: document.positionAt(0),
				end: document.positionAt(document.getText().length),
			};

			if (virtualCode) {
				codeOptions = {
					level: embeddedLevel - 1,
					initialIndentLevel: 0,
				};
				if (virtualCode.mappings.length) {
					const firstMapping = virtualCode.mappings[0];
					const startOffset = firstMapping.sourceOffsets[0];
					const startPosition = sourceDocument.positionAt(startOffset);
					codeOptions.initialIndentLevel = computeInitialIndent(
						sourceDocument.getText(),
						sourceDocument.offsetAt({ line: startPosition.line, character: 0 }),
						options,
					);
				}
				for (const service of context.services) {
					if (context.disabledServicePlugins.has(service[1])) {
						continue;
					}
					codeOptions = await service[1].resolveEmbeddedCodeFormattingOptions?.(sourceScript, virtualCode, codeOptions, token) ?? codeOptions;
				}
			}

			for (const service of context.services) {
				if (context.disabledServicePlugins.has(service[1])) {
					continue;
				}

				if (token.isCancellationRequested) {
					break;
				}

				let edits: vscode.TextEdit[] | null | undefined;

				try {
					if (ch !== undefined && rangeOrPosition && 'line' in rangeOrPosition && 'character' in rangeOrPosition) {
						if (service[0].autoFormatTriggerCharacters?.includes(ch)) {
							edits = await service[1].provideOnTypeFormattingEdits?.(document, rangeOrPosition, ch, options, codeOptions, token);
						}
					}
					else if (ch === undefined && rangeOrPosition && 'start' in rangeOrPosition && 'end' in rangeOrPosition) {
						edits = await service[1].provideDocumentFormattingEdits?.(document, rangeOrPosition, options, codeOptions, token);
					}
				}
				catch (err) {
					console.warn(err);
				}

				if (!edits) {
					continue;
				}

				return {
					service,
					edits,
				};
			}
		}
	};

	function createDocMap(virtualCode: VirtualCode, documentUri: string, sourceLanguageId: string, _sourceSnapshot: ts.IScriptSnapshot) {
		const mapOfMap = new Map<string, [ts.IScriptSnapshot, SourceMap<CodeInformation>]>();
		updateVirtualCodeMapOfMap(virtualCode, mapOfMap, sourceFileUri2 => {
			if (!sourceFileUri2) {
				return [documentUri, _sourceSnapshot];
			}
		});
		if (mapOfMap.has(documentUri) && mapOfMap.get(documentUri)![0] === _sourceSnapshot) {
			const map = mapOfMap.get(documentUri)!;
			const version = fakeVersion++;
			return new SourceMapWithDocuments(
				TextDocument.create(
					documentUri,
					sourceLanguageId,
					version,
					_sourceSnapshot.getText(0, _sourceSnapshot.getLength())
				),
				TextDocument.create(
					context.encodeEmbeddedDocumentUri(documentUri, virtualCode.id),
					virtualCode.languageId,
					version,
					virtualCode.snapshot.getText(0, virtualCode.snapshot.getLength())
				),
				map[1],
			);
		}
	}
}

function computeInitialIndent(content: string, i: number, options: vscode.FormattingOptions) {
	let nChars = 0;
	const tabSize = options.tabSize || 4;
	while (i < content.length) {
		const ch = content.charAt(i);
		if (ch === ' ') {
			nChars++;
		} else if (ch === '\t') {
			nChars += tabSize;
		} else {
			break;
		}
		i++;
	}
	return Math.floor(nChars / tabSize);
}
