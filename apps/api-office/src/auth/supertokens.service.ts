import { Injectable, Inject } from '@nestjs/common';
import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import EmailPassword from "supertokens-node/recipe/emailpassword";

export const ConfigInjectionToken = "ConfigInjectionToken";
export interface AuthModuleConfig {
    appInfo: {
        appName: string;
        apiDomain: string;
        websiteDomain: string;
        apiBasePath: string;
        websiteBasePath: string;
    };
    connectionURI: string;
    apiKey?: string;
}

@Injectable()
export class SupertokensService {
    constructor(@Inject(ConfigInjectionToken) private config: AuthModuleConfig) {
        supertokens.init({
            appInfo: config.appInfo,
            supertokens: {
                connectionURI: config.connectionURI,
                apiKey: config.apiKey,
            },
            recipeList: [
                EmailPassword.init(),
                Session.init(),
            ]
        });
    }
}
