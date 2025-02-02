import { LanguagePlugin, LanguageService, ServiceEnvironment, createLanguage, createLanguageService } from '@volar/language-service';
import type { ServerBase, ServerProject } from '../types';

export async function createSimpleServerProject(
	server: ServerBase,
	serviceEnv: ServiceEnvironment,
	languagePlugins: LanguagePlugin[],
): Promise<ServerProject> {
	let languageService: LanguageService | undefined;

	return {
		getLanguageService,
		getLanguageServiceDontCreate: () => languageService,
		dispose() {
			languageService?.dispose();
		},
	};

	function getLanguageService() {
		if (!languageService) {
			const language = createLanguage(languagePlugins, false, uri => {
				const document = server.documents.get(uri);
				if (document) {
					language.scripts.set(uri, document.getSnapshot(), document.languageId);
				}
				else {
					language.scripts.delete(uri);
				}
			});
			languageService = createLanguageService(
				language,
				server.languageServicePlugins,
				serviceEnv,
			);
		}
		return languageService;
	}
}
