import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverExistingCustomerFolders,
  folderIsInside,
  folderOrAncestorHasSpecialUse,
  resolveCustomerFolder,
  resolveOrganizerArchive,
  setupAllCustomerFolders
} from "../extension/lib/folders.js";
import {SPECIAL_SOURCE_TYPES} from "../extension/lib/constants.js";

test("folder ancestry uses Thunderbird parent IDs", async () => {
  const folder = {id: "child", accountId: "work", name: "Child"};
  const customerRoot = {id: "customers", accountId: "work", name: "Customers"};
  const api = {
    folders: {
      getParentFolders: async id => {
        assert.equal(id, "child");
        return [{id: "parent"}, customerRoot];
      }
    }
  };

  assert.equal(await folderIsInside(folder, customerRoot, api), true);
});

test("children of excluded special folders are excluded", async () => {
  const child = {id: "trash-child", accountId: "work", name: "Imported"};
  const api = {
    folders: {
      getParentFolders: async () => [
        {id: "trash", accountId: "work", specialUse: ["trash"]}
      ]
    }
  };

  assert.equal(
    await folderOrAncestorHasSpecialUse(child, SPECIAL_SOURCE_TYPES, api),
    true
  );
});

test("stale existing destinations fail without creating replacement folders", async () => {
  let createCalls = 0;
  const account = {
    id: "work",
    name: "Work",
    rootFolder: {id: "root", accountId: "work", name: "Work"}
  };
  const accountConfig = {
    rootFolderName: "Customers",
    archiveFolderName: "Organizer Archive"
  };
  const customer = {folderName: "Acme"};
  const api = {
    folders: {
      getSubFolders: async () => [],
      create: async () => {
        createCalls += 1;
        return {id: "unexpected"};
      }
    }
  };

  await assert.rejects(
    resolveCustomerFolder(
      account,
      accountConfig,
      customer,
      true,
      api,
      "old-destination-id"
    ),
    /root changed after preview/u
  );
  assert.equal(createCalls, 0);
});

test("a destination that appears after preview is not silently adopted", async () => {
  let createCalls = 0;
  const root = {id: "customers", accountId: "work", name: "Customers"};
  const account = {
    id: "work",
    name: "Work",
    rootFolder: {id: "root", accountId: "work", name: "Work"}
  };
  const api = {
    folders: {
      getSubFolders: async id => id === "root"
        ? [root]
        : [{id: "surprise", accountId: "work", name: "Acme"}],
      create: async () => {
        createCalls += 1;
        return {id: "unexpected"};
      }
    }
  };

  await assert.rejects(
    resolveCustomerFolder(
      account,
      {rootFolderName: "Customers", customerRootReady: true},
      {folderName: "Acme"},
      true,
      api,
      null,
      "customers",
      true
    ),
    /appeared after preview/u
  );
  assert.equal(createCalls, 0);
});

test("an existing unbound folder is not silently adopted as Organizer Archive", async () => {
  const archive = {id: "old-archive", accountId: "work", name: "Organizer Archive"};
  const account = {
    id: "work",
    name: "Work",
    rootFolder: {id: "root", accountId: "work", name: "Work"}
  };
  const api = {
    folders: {
      getSubFolders: async () => [archive]
    }
  };

  await assert.rejects(
    resolveOrganizerArchive(
      account,
      {archiveFolderName: "Organizer Archive", archiveReady: false},
      true,
      api,
      true
    ),
    /already exists/u
  );
});

test("normal archive resolution requires prior setup approval", async () => {
  const archive = {id: "old-archive", accountId: "work", name: "Organizer Archive"};
  const account = {
    id: "work",
    name: "Work",
    rootFolder: {id: "root", accountId: "work", name: "Work"}
  };
  const api = {
    folders: {
      getSubFolders: async () => [archive]
    }
  };

  assert.equal(
    await resolveOrganizerArchive(
      account,
      {archiveFolderName: "Organizer Archive", archiveReady: false},
      false,
      api
    ),
    null
  );
});

test("stale organizer destinations that become special-use are rejected", async () => {
  const account = {
    id: "work",
    name: "Work",
    rootFolder: {id: "root", accountId: "work", name: "Work"}
  };
  const customerRoot = {
    id: "customers",
    accountId: "work",
    name: "Customers",
    specialUse: []
  };
  const customerFolder = {
    id: "acme",
    accountId: "work",
    name: "Acme",
    specialUse: ["trash"]
  };
  const archive = {
    id: "organizer-archive",
    accountId: "work",
    name: "Organizer Archive",
    specialUse: ["archives"]
  };
  const api = {
    folders: {
      getSubFolders: async id => id === "root"
        ? [customerRoot, archive]
        : id === "customers"
          ? [customerFolder]
          : [],
      getFolderCapabilities: async () => ({canAddMessages: true})
    }
  };

  await assert.rejects(
    resolveOrganizerArchive(
      account,
      {archiveFolderName: "Organizer Archive", archiveReady: true},
      false,
      api
    ),
    /special-use folder/u
  );
  await assert.rejects(
    resolveCustomerFolder(
      account,
      {rootFolderName: "Customers", customerRootReady: true},
      {folderName: "Acme"},
      false,
      api,
      "acme",
      "customers"
    ),
    /special-use folder/u
  );

  customerRoot.specialUse = ["junk"];
  customerFolder.specialUse = [];
  await assert.rejects(
    resolveCustomerFolder(
      account,
      {rootFolderName: "Customers", customerRootReady: true},
      {folderName: "Acme"},
      false,
      api,
      "acme",
      "customers"
    ),
    /customer root/u
  );
});

function existingFolderSetup({rootSpecialUse = [], archiveSpecialUse = []} = {}) {
  const accountRoot = {id: "root", accountId: "work", name: "Work", isRoot: true};
  const customerRoot = {
    id: "customers",
    accountId: "work",
    name: "Customers",
    specialUse: rootSpecialUse
  };
  const archive = {
    id: "archive",
    accountId: "work",
    name: "Organizer Archive",
    specialUse: archiveSpecialUse
  };
  const customerFolder = {
    id: "acme",
    accountId: "work",
    name: "Acme",
    specialUse: []
  };
  const account = {id: "work", name: "Work", rootFolder: accountRoot};
  const config = {
    accounts: {
      work: {
        enabled: true,
        rootFolderName: "Customers",
        customerRootReady: false,
        archiveFolderName: "Organizer Archive",
        archiveReady: false
      }
    },
    customers: [{
      id: "acme-rule",
      name: "Acme",
      folderName: "Acme",
      enabled: true,
      accountIds: [],
      domains: ["acme.com"],
      addresses: [],
      keywords: []
    }]
  };
  let createCalls = 0;
  const api = {
    folders: {
      getSubFolders: async id => {
        if (id === accountRoot.id) return [customerRoot, archive];
        if (id === customerRoot.id) return [customerFolder];
        return [];
      },
      getFolderCapabilities: async id => ({
        canAddMessages: id !== customerRoot.id,
        canAddSubfolders: id === customerRoot.id
      }),
      create: async () => {
        createCalls += 1;
        throw new Error("setup must not create a folder while adopting existing folders");
      }
    }
  };
  return {account, config, api, getCreateCalls: () => createCalls};
}

test("explicit setup approval adopts exact existing root, archive, and customer folders", async () => {
  const fixture = existingFolderSetup();
  const result = await setupAllCustomerFolders(
    fixture.config,
    [fixture.account],
    fixture.api,
    {
      folderApprovals: {
        work: {
          rootFolderName: "Customers",
          archiveFolderName: "Organizer Archive",
          adoptExistingRoot: true,
          adoptExistingArchive: true
        }
      }
    }
  );

  assert.deepEqual(result.errors, []);
  assert.equal(fixture.config.accounts.work.customerRootReady, true);
  assert.equal(fixture.config.accounts.work.archiveReady, true);
  assert.equal(fixture.getCreateCalls(), 0);
  assert.deepEqual(
    result.folders.map(folder => folder.folderName).sort(),
    ["Acme", "Organizer Archive"]
  );
});

test("setup does not adopt existing folders without exact-name approval", async () => {
  const fixture = existingFolderSetup();
  const result = await setupAllCustomerFolders(
    fixture.config,
    [fixture.account],
    fixture.api,
    {
      folderApprovals: {
        work: {
          rootFolderName: "Different root",
          archiveFolderName: "Different archive",
          adoptExistingRoot: true,
          adoptExistingArchive: true
        }
      }
    }
  );

  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some(error => /not an approved organizer root/u.test(error)));
  assert.ok(result.errors.some(error => /already exists/u.test(error)));
  assert.equal(fixture.config.accounts.work.customerRootReady, false);
  assert.equal(fixture.config.accounts.work.archiveReady, false);
  assert.equal(fixture.getCreateCalls(), 0);
});

test("explicit adoption fails closed when the approved folders are absent", async () => {
  const account = {
    id: "work",
    name: "Work",
    rootFolder: {id: "root", accountId: "work", name: "Work", isRoot: true}
  };
  const config = {
    accounts: {
      work: {
        enabled: true,
        rootFolderName: "Customers",
        customerRootReady: false,
        archiveFolderName: "Organizer Archive",
        archiveReady: false
      }
    },
    customers: []
  };
  let createCalls = 0;
  const api = {
    folders: {
      getSubFolders: async () => [],
      create: async () => {
        createCalls += 1;
        return {id: "unexpected"};
      }
    }
  };

  const result = await setupAllCustomerFolders(config, [account], api, {
    folderApprovals: {
      work: {
        rootFolderName: "Customers",
        archiveFolderName: "Organizer Archive",
        adoptExistingRoot: true,
        adoptExistingArchive: true
      }
    }
  });

  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(error => /No existing folder named/u.test(error)));
  assert.equal(config.accounts.work.customerRootReady, false);
  assert.equal(config.accounts.work.archiveReady, false);
  assert.equal(createCalls, 0);
});

test("special-use folders cannot be adopted even with explicit approval", async () => {
  const fixture = existingFolderSetup({
    rootSpecialUse: ["junk"],
    archiveSpecialUse: ["archives"]
  });
  const result = await setupAllCustomerFolders(
    fixture.config,
    [fixture.account],
    fixture.api,
    {
      folderApprovals: {
        work: {
          rootFolderName: "Customers",
          archiveFolderName: "Organizer Archive",
          adoptExistingRoot: true,
          adoptExistingArchive: true
        }
      }
    }
  );

  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(error => /special-use/u.test(error)));
  assert.equal(fixture.config.accounts.work.customerRootReady, false);
  assert.equal(fixture.config.accounts.work.archiveReady, false);
  assert.equal(fixture.getCreateCalls(), 0);
});

test("existing-folder discovery returns only direct normal writable children", async () => {
  const accountRoot = {id: "root", accountId: "work", name: "Work", isRoot: true};
  const customerRoot = {id: "customers", accountId: "work", name: "Customers", specialUse: []};
  const direct = {id: "acme", accountId: "work", name: "acme.com", specialUse: []};
  const special = {id: "drafts", accountId: "work", name: "Drafts", specialUse: ["drafts"]};
  const readOnly = {id: "readonly", accountId: "work", name: "Read only", specialUse: []};
  const nested = {id: "nested", accountId: "work", name: "nested.example", specialUse: []};
  const queried = [];
  const api = {
    folders: {
      getSubFolders: async id => {
        queried.push(id);
        if (id === accountRoot.id) return [customerRoot];
        if (id === customerRoot.id) return [direct, special, readOnly];
        if (id === direct.id) return [nested];
        return [];
      },
      getFolderCapabilities: async id => ({canAddMessages: id !== readOnly.id})
    }
  };

  const result = await discoverExistingCustomerFolders(
    {id: "work", name: "Work", rootFolder: accountRoot},
    "Customers",
    api
  );

  assert.deepEqual(result, {
    accountId: "work",
    accountName: "Work",
    rootFolderName: "Customers",
    folders: [{name: "acme.com"}]
  });
  assert.deepEqual(queried, ["root", "customers"]);
});

test("existing-folder discovery rejects a root that cannot contain customer folders", async () => {
  const accountRoot = {id: "root", accountId: "work", name: "Work", isRoot: true};
  const customerRoot = {id: "customers", accountId: "work", name: "Customers", specialUse: []};
  const api = {
    folders: {
      getSubFolders: async id => id === accountRoot.id ? [customerRoot] : [],
      getFolderCapabilities: async id => ({canAddSubfolders: id !== customerRoot.id})
    }
  };

  await assert.rejects(
    discoverExistingCustomerFolders(
      {id: "work", name: "Work", rootFolder: accountRoot},
      "Customers",
      api
    ),
    /cannot contain customer folders/u
  );
});

test("existing-folder discovery rejects ambiguous case-equivalent child names", async () => {
  const accountRoot = {id: "root", accountId: "work", name: "Work", isRoot: true};
  const customerRoot = {id: "customers", accountId: "work", name: "Customers", specialUse: []};
  const api = {
    folders: {
      getSubFolders: async id => {
        if (id === accountRoot.id) return [customerRoot];
        if (id === customerRoot.id) {
          return [
            {id: "acme-a", accountId: "work", name: "Acme"},
            {id: "acme-b", accountId: "work", name: "ACME"}
          ];
        }
        return [];
      },
      getFolderCapabilities: async () => ({
        canAddMessages: true,
        canAddSubfolders: true
      })
    }
  };

  await assert.rejects(
    discoverExistingCustomerFolders(
      {id: "work", name: "Work", rootFolder: accountRoot},
      "Customers",
      api
    ),
    /More than one direct folder matches/u
  );
});
