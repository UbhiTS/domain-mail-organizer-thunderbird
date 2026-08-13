import test from "node:test";
import assert from "node:assert/strict";

import {createMoveConfirmationBroker} from "../extension/lib/move-confirmation.js";

function event() {
  let listener;
  return {
    addListener(value) {
      listener = value;
    },
    emit(...args) {
      return listener(...args);
    }
  };
}

function page(message) {
  return {id: null, messages: [message]};
}

function apiFixture() {
  return {
    messages: {
      onMoved: event(),
      onCopied: event()
    }
  };
}

test("automatic move confirmation accepts the matching onMoved event", async () => {
  const api = apiFixture();
  const broker = createMoveConfirmationBroker(api);
  const source = {id: "inbox", accountId: "work"};
  const destination = {id: "acme", accountId: "work"};

  await broker.confirmMove(
    {messageId: 1, sourceFolderId: source.id, destinationFolderId: destination.id},
    async () => api.messages.onMoved.emit(
      page({id: 1, folder: source}),
      page({id: 2, folder: destination})
    )
  );
});

test("move confirmation captures a non-awaited asynchronous event listener", async () => {
  const api = apiFixture();
  const broker = createMoveConfirmationBroker(api);
  const source = {id: "inbox", accountId: "work"};
  const destination = {id: "acme", accountId: "work"};

  await broker.confirmMove(
    {messageId: 1, sourceFolderId: source.id, destinationFolderId: destination.id},
    async () => {
      // Thunderbird dispatches extension events asynchronously and does not
      // await listener Promises before the move API itself can resolve.
      void api.messages.onMoved.emit(
        page({id: 1, folder: source}),
        page({id: 2, folder: destination})
      );
    }
  );
});

test("automatic move confirmation rejects a copy event", async () => {
  const api = apiFixture();
  const broker = createMoveConfirmationBroker(api);
  const source = {id: "inbox", accountId: "work"};
  const destination = {id: "acme", accountId: "work"};

  await assert.rejects(
    broker.confirmMove(
      {messageId: 1, sourceFolderId: source.id, destinationFolderId: destination.id},
      async () => api.messages.onCopied.emit(
        page({id: 1, folder: source}),
        page({id: 2, folder: destination})
      )
    ),
    /copied.+left the original/u
  );
});

test("a resolved move without an immediate event stays journaled for Inbox reconciliation", async () => {
  const api = apiFixture();
  let operations = 0;
  const broker = createMoveConfirmationBroker(api);

  const result = await broker.confirmMove(
      {messageId: 1, sourceFolderId: "inbox", destinationFolderId: "acme"},
      async () => {
        operations += 1;
      }
    );
  assert.equal(result.status, "accepted");
  assert.equal(operations, 1);
});

test("a move event may arrive after the move API resolves", async () => {
  const api = apiFixture();
  const broker = createMoveConfirmationBroker(api);
  const source = {id: "inbox", accountId: "work"};
  const destination = {id: "acme", accountId: "work"};

  const result = await broker.confirmMove(
    {messageId: 1, sourceFolderId: source.id, destinationFolderId: destination.id},
    async () => {
      setTimeout(() => {
        void api.messages.onMoved.emit(
          page({id: 1, folder: source}),
          page({id: 2, folder: destination})
        );
      }, 10);
    }
  );

  assert.equal(result.status, "accepted");
  await new Promise(resolve => setTimeout(resolve, 15));
});

test("a slow move is not governed by a pre-operation wall-clock timeout", async () => {
  const api = apiFixture();
  const broker = createMoveConfirmationBroker(api);
  const source = {id: "inbox", accountId: "work"};
  const destination = {id: "acme", accountId: "work"};

  await broker.confirmMove(
    {messageId: 1, sourceFolderId: source.id, destinationFolderId: destination.id},
    async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      await api.messages.onMoved.emit(
        page({id: 1, folder: source}),
        page({id: 2, folder: destination})
      );
    }
  );
});
