import type { LanguagePlugin, SourceScript } from '@volar/language-core';
import type * as ts from 'typescript';

export function createResolveModuleName(
	ts: typeof import('typescript'),
	host: ts.ModuleResolutionHost,
	languagePlugins: LanguagePlugin<any>[],
	getSourceScript: (fileName: string) => SourceScript | undefined,
) {
	const toSourceFileInfo = new Map<string, {
		sourceFileName: string;
		extension: string;
	}>();
	const moduleResolutionHost: ts.ModuleResolutionHost = {
		readFile: host.readFile.bind(host),
		directoryExists: host.directoryExists?.bind(host),
		realpath: host.realpath?.bind(host),
		getCurrentDirectory: host.getCurrentDirectory?.bind(host),
		getDirectories: host.getDirectories?.bind(host),
		useCaseSensitiveFileNames: typeof host.useCaseSensitiveFileNames === 'function'
			? host.useCaseSensitiveFileNames.bind(host)
			: host.useCaseSensitiveFileNames,
		fileExists(fileName) {
			for (const { typescript } of languagePlugins) {
				if (!typescript) {
					continue;
				}
				for (const { extension } of typescript.extraFileExtensions) {
					if (fileName.endsWith(`.d.${extension}.ts`)) {
						const sourceFileName = fileName.slice(0, -`.d.${extension}.ts`.length) + `.${extension}`;
						if (fileExists(sourceFileName)) {
							const sourceScript = getSourceScript(sourceFileName);
							if (sourceScript?.generated) {
								const serviceScript = sourceScript.generated.languagePlugin.typescript?.getServiceScript(sourceScript.generated.root);
								if (serviceScript) {
									const dtsPath = sourceFileName + '.d.ts';
									if ((serviceScript.extension === '.js' || serviceScript.extension === '.jsx') && fileExists(dtsPath)) {
										toSourceFileInfo.set(fileName, {
											sourceFileName: dtsPath,
											extension: '.ts',
										});
									}
									else {
										toSourceFileInfo.set(fileName, {
											sourceFileName,
											extension: serviceScript.extension,
										});
									}
									return true;
								}
							}
						}
					}
				}
			}
			return host.fileExists(fileName);
		},
	};
	return (
		moduleName: string,
		containingFile: string,
		compilerOptions: ts.CompilerOptions,
		cache?: ts.ModuleResolutionCache,
		redirectedReference?: ts.ResolvedProjectReference,
		resolutionMode?: ts.ResolutionMode
	) => {
		const result = ts.resolveModuleName(
			moduleName,
			containingFile,
			compilerOptions,
			moduleResolutionHost,
			cache,
			redirectedReference,
			resolutionMode
		);
		if (result.resolvedModule) {
			const sourceFileInfo = toSourceFileInfo.get(result.resolvedModule.resolvedFileName);
			if (sourceFileInfo) {
				result.resolvedModule.resolvedFileName = sourceFileInfo.sourceFileName;
				result.resolvedModule.extension = sourceFileInfo.extension;
			}
		}
		toSourceFileInfo.clear();
		return result;
	};

	// fix https://github.com/vuejs/language-tools/issues/3332
	function fileExists(fileName: string) {
		if (host.fileExists(fileName)) {
			const fileSize = ts.sys.getFileSize?.(fileName) ?? host.readFile(fileName)?.length ?? 0;
			return fileSize < 4 * 1024 * 1024;
		}
		return false;
	}
}
