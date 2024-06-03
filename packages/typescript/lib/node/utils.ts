import type { Language } from '@volar/language-core';

export function notEmpty<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined;
}

export function getServiceScript(language: Language, fileName: string) {
	let sourceScript = language.scripts.get(fileName);
	if (sourceScript?.nonTs || !sourceScript?.generated) {
		sourceScript = language.scripts.getGeneratedTarget(fileName) ?? sourceScript
	}
	if (sourceScript?.generated) {
		const serviceScript = sourceScript.generated.languagePlugin.typescript?.getServiceScript(sourceScript.generated.root);
		if (serviceScript) {
			const map = language.maps.get(serviceScript.code, fileName);
			if (map) {
				return [serviceScript, sourceScript, map] as const;
			}
		}
	}
	if (sourceScript?.nonTs) {
		return [undefined, sourceScript, undefined] as const
	}
	return [undefined, undefined, undefined] as const;
}
