/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action } from 'vs/base/common/actions';
import * as nls from 'vs/nls';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { Registry } from 'vs/platform/registry/common/platform';
import { IWorkbenchActionRegistry, Extensions } from 'vs/workbench/common/actions';
import { SyncActionDescriptor, MenuRegistry, MenuId } from 'vs/platform/actions/common/actions';
import { IProductService } from 'vs/platform/product/common/productService';
import { URI } from 'vs/base/common/uri';

class OpenUrlAction extends Action {

	static readonly ID = 'workbench.action.openBaidu';
	static readonly LABEL = nls.localize('openDocumentationUrl', "Documentation");
	static readonly AVAILABLE = true;

	constructor(
		id: string,
		label: string,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService
	) {
		super(id, label);
	}

	run(): Promise<void> {
		if (this.productService.documentationUrl) {
			this.openerService.open(URI.parse(this.productService.documentationUrl));
		}
		return Promise.resolve();
	}
}



// --- Actions Registration

const registry = Registry.as<IWorkbenchActionRegistry>(Extensions.WorkbenchActions);
const myMenuCategory = nls.localize('myMenuActions', "MyMenuAction");

if (OpenUrlAction.AVAILABLE) {
	registry.registerWorkbenchAction(SyncActionDescriptor.create(OpenUrlAction, OpenUrlAction.ID, OpenUrlAction.LABEL), 'MyMenuAction: Documentation', myMenuCategory);
}


if (OpenUrlAction.AVAILABLE) {
	MenuRegistry.appendMenuItem(MenuId.MenubarLogin, {
		group: '1_login',
		command: {
			id: OpenUrlAction.ID,
			title: nls.localize({ key: 'miDocumentation', comment: ['&& denotes a mnemonic'] }, "&&Documentation")
		},
		order: 1
	});
}
