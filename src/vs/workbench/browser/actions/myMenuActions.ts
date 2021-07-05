/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { localize } from 'vs/nls';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { URI } from 'vs/base/common/uri';
import { MenuId, Action2, MenuRegistry, registerAction2 } from 'vs/platform/actions/common/actions';
import { IProductService } from 'vs/platform/product/common/productService';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';



class OpenUrlAction extends Action2 {

	static readonly ID = 'workbench.action.openBaidu';
	static readonly LABEL = localize('openBaiduUrl', "baidu");
	static readonly AVAILABLE = true;

	constructor() {
		super({
			id: OpenUrlAction.ID,
			title: { value: localize('baiduUrl', "baidu"), original: 'baidu' }
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		const productService = accessor.get(IProductService);
		const openerService = accessor.get(IOpenerService);
		if (productService.baiduUrl) {
			openerService.open(URI.parse(productService.baiduUrl));
		}
		return Promise.resolve();
	}
}



// --- Actions Registration

if (OpenUrlAction.AVAILABLE) {
	registerAction2(OpenUrlAction);
}


if (OpenUrlAction.AVAILABLE) {
	MenuRegistry.appendMenuItem(MenuId.MenubarLogin, {
		group: '1_login',
		command: {
			id: OpenUrlAction.ID,
			title: localize({ key: 'miBaidu', comment: ['&& denotes a mnemonic'] }, "&&Baidu")
		},
		order: 1
	});
}
