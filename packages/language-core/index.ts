export * from '@volar/source-map';
export * from './lib/editorFeatures';
export * from './lib/linkedCodeMap';
export * from './lib/types';
export * from './lib/utils';

import { SourceMap } from '@volar/source-map';
import type * as ts from 'typescript';
import { LinkedCodeMap } from './lib/linkedCodeMap';
import type { CodeInformation, Language, LanguagePlugin, SourceScript, VirtualCode } from './lib/types';
import { FileMap } from './lib/utils';

export function createLanguage(plugins: LanguagePlugin[], caseSensitive: boolean, sync: (id: string) => void): Language {

	const sourceScripts = new FileMap<SourceScript>(caseSensitive);
	const nonTsSourceScripts = new FileMap<SourceScript>(caseSensitive);

	const sourceScriptToMappedFiles = new Map<SourceScript, string[]>()
	const mappedFilesToSourceScript = new FileMap<SourceScript>(caseSensitive);

	const virtualCodeToSourceFileMap = new WeakMap<VirtualCode, SourceScript>();
	const virtualCodeToMaps = new WeakMap<ts.IScriptSnapshot, Map<string, [ts.IScriptSnapshot, SourceMap<CodeInformation>]>>();
	const virtualCodeToLinkedCodeMap = new WeakMap<ts.IScriptSnapshot, LinkedCodeMap | undefined>();

	function unregisterSourceScript(sourceScript: SourceScript) {
		for (const mappedFile of sourceScriptToMappedFiles.get(sourceScript) ?? []) {
			mappedFilesToSourceScript.delete(mappedFile);
		}
		sourceScriptToMappedFiles.delete(sourceScript)
	}

	function registerSourceScript(sourceScript: SourceScript, virtualCode: VirtualCode) {
		if (!sourceScript.generated) {
			return
		}
		const mappedFiles: string[] = []
		unregisterSourceScript(sourceScript)
		sourceScriptToMappedFiles.set(sourceScript, mappedFiles)
		for (const code of forEachEmbeddedCode(virtualCode)) {
			virtualCodeToSourceFileMap.set(code, sourceScript);
			sourceScript.generated.embeddedCodes.set(code.id, code);
			for (const mapping of code.mappings) {
				if (mapping.source && mapping.source !== sourceScript.id) {
					mappedFiles.push(mapping.source)
					mappedFilesToSourceScript.set(mapping.source, sourceScript)
				}
			}
		}
	}

	function normalizeId(id: string): string {
		return caseSensitive ? id : id.toLowerCase();
	}

	return {
		plugins,
		scripts: {
			get(id) {
				sync(id);
				return sourceScripts.get(id) ?? nonTsSourceScripts.get(id)
			},
			getGeneratedTarget(id) {
				return mappedFilesToSourceScript.get(id)
			},
			set(id, snapshot, languageId, _plugins = plugins) {
				if (!languageId) {
					for (const plugin of plugins) {
						languageId = plugin.getLanguageId?.(id);
						if (languageId) {
							break;
						}
					}
				}
				if (!languageId) {
					console.warn(`languageId not found for ${id}`);
					return;
				}
				let isMappingSourceOnly = false;
				for (const plugin of plugins) {
					if (plugin.isNonTS?.(id, languageId)) {
						isMappingSourceOnly = true
						break;
					}
				}
				if (!isMappingSourceOnly) {
					if (nonTsSourceScripts.has(id)) {
						this.delete(id);
						return this.set(id, snapshot, languageId);
					} else if (sourceScripts.has(id)) {
						const sourceScript = sourceScripts.get(id)!;
						if (sourceScript.languageId !== languageId) {
							// languageId changed
							this.delete(id);
							return this.set(id, snapshot, languageId);
						} else if (sourceScript.snapshot !== snapshot) {
							// snapshot updated
							sourceScript.snapshot = snapshot;
							if (sourceScript.generated) {
								const newVirtualCode = sourceScript.generated.languagePlugin.updateVirtualCode?.(id, sourceScript.generated.root, snapshot);
								if (newVirtualCode) {
									sourceScript.generated.root = newVirtualCode;
									sourceScript.generated.embeddedCodes.clear();
									registerSourceScript(sourceScript, newVirtualCode);
									return sourceScript;
								} else {
									this.delete(id);
									return;
								}
							}
						} else {
							// not changed
							return sourceScript;
						}
					} else {
						// created
						const sourceScript: SourceScript = { id, languageId, snapshot };
						sourceScripts.set(id, sourceScript);
						for (const languagePlugin of _plugins) {
							const virtualCode = languagePlugin.createVirtualCode?.(id, languageId, snapshot);
							if (virtualCode) {
								sourceScript.generated = {
									root: virtualCode,
									languagePlugin,
									embeddedCodes: new Map(),
								};
								registerSourceScript(sourceScript, virtualCode);
								break;
							}
						}
						return sourceScript;
					}
				} else {
					if (sourceScripts.has(id)) {
						this.delete(id);
						return this.set(id, snapshot, languageId);
					} if (nonTsSourceScripts.has(id)) {
						const sourceScript = nonTsSourceScripts.get(id)!;
						if (sourceScript.languageId !== languageId) {
							// languageId changed
							this.delete(id);
							return this.set(id, snapshot, languageId);
						} else if (sourceScript.snapshot !== snapshot) {
							// snapshot updated
							sourceScript.snapshot = snapshot;
						} else {
							// not changed
							return sourceScript;
						}
					} else {
						// created
						const sourceScript: SourceScript = { id, languageId, snapshot, nonTs: true };
						nonTsSourceScripts.set(id, sourceScript);
						return sourceScript;
					}
				}
			},
			delete(id) {
				nonTsSourceScripts.delete(id)
				const value = sourceScripts.get(id);
				if (value) {
					if (value.generated) {
						value.generated.languagePlugin.disposeVirtualCode?.(id, value.generated.root);
					}
					unregisterSourceScript(value)
					sourceScripts.delete(id);
				}
			},
		},
		maps: {
			get(virtualCode, scriptId) {
				if (!scriptId) {
					const sourceScript = virtualCodeToSourceFileMap.get(virtualCode);
					if (!sourceScript) {
						return;
					}
					scriptId = sourceScript.id;
				}
				scriptId = normalizeId(scriptId)
				for (const [id, [_snapshot, map]] of this.forEach(virtualCode)) {
					if (normalizeId(id) === scriptId) {
						return map;
					}
				}
			},
			forEach(virtualCode) {
				let map = virtualCodeToMaps.get(virtualCode.snapshot);
				if (!map) {
					map = new Map();
					virtualCodeToMaps.set(virtualCode.snapshot, map);
				}
				updateVirtualCodeMapOfMap(virtualCode, map, id => {
					if (id) {
						const sourceScript = sourceScripts.get(id)! ?? nonTsSourceScripts.get(id)!;
						return [id, sourceScript.snapshot];
					}
					else {
						const sourceScript = virtualCodeToSourceFileMap.get(virtualCode)!;
						return [sourceScript.id, sourceScript.snapshot];
					}
				});
				return map;
			},
		},
		linkedCodeMaps: {
			get(virtualCode) {
				if (!virtualCodeToLinkedCodeMap.has(virtualCode.snapshot)) {
					virtualCodeToLinkedCodeMap.set(
						virtualCode.snapshot,
						virtualCode.linkedCodeMappings
							? new LinkedCodeMap(virtualCode.linkedCodeMappings)
							: undefined
					);
				}
				return virtualCodeToLinkedCodeMap.get(virtualCode.snapshot);
			},
		},
	};
}

export function updateVirtualCodeMapOfMap(
	virtualCode: VirtualCode,
	mapOfMap: Map<string, [ts.IScriptSnapshot, SourceMap<CodeInformation>]>,
	getSourceSnapshot: (id: string | undefined) => [string, ts.IScriptSnapshot] | undefined,
) {
	const sources = new Set<string | undefined>();
	if (!virtualCode.mappings.length) {
		const source = getSourceSnapshot(undefined);
		if (source) {
			mapOfMap.set(source[0], [source[1], new SourceMap([])]);
		}
	}
	for (const mapping of virtualCode.mappings) {
		if (sources.has(mapping.source)) {
			continue;
		}
		sources.add(mapping.source);
		const source = getSourceSnapshot(mapping.source);
		if (!source) {
			continue;
		}
		if (!mapOfMap.has(source[0]) || mapOfMap.get(source[0])![0] !== source[1]) {
			mapOfMap.set(source[0], [source[1], new SourceMap(virtualCode.mappings, source[0])]);
		}
	}
}

export function* forEachEmbeddedCode(virtualCode: VirtualCode): Generator<VirtualCode> {
	yield virtualCode;
	if (virtualCode.embeddedCodes) {
		for (const embeddedCode of virtualCode.embeddedCodes) {
			yield* forEachEmbeddedCode(embeddedCode);
		}
	}
}
