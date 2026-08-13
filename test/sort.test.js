import test from "node:test";
import assert from "node:assert/strict";
import {customersByName, newestMessagesFirst} from "../extension/lib/sort.js";

test("organizer rows render newest first without mutating the stored plan", () => {
  const items = [
    {id: "older", date: "2026-08-12T11:25:03.000Z"},
    {id: "missing", date: ""},
    {id: "newest", date: "2026-08-12T15:18:28.000Z"},
    {id: "middle", date: "2026-08-12T13:02:32.000Z"},
    {id: "invalid", date: "not-a-date"}
  ];

  assert.deepEqual(
    newestMessagesFirst(items).map(item => item.id),
    ["newest", "middle", "older", "missing", "invalid"]
  );
  assert.deepEqual(
    items.map(item => item.id),
    ["older", "missing", "newest", "middle", "invalid"]
  );
});

test("equal timestamps keep their original order", () => {
  const items = [
    {id: "first", date: "2026-08-12T15:18:28.000Z"},
    {id: "second", date: "2026-08-12T15:18:28.000Z"}
  ];

  assert.deepEqual(
    newestMessagesFirst(items).map(item => item.id),
    ["first", "second"]
  );
});

test("customers sort by name without mutating storage order", () => {
  const customers = [
    {id: "blank", name: "   "},
    {id: "ten", name: "Customer 10"},
    {id: "beta", name: "beta"},
    {id: "two", name: "Customer 2"},
    {id: "alpha", name: "Alpha"},
    {id: "alpha-equal", name: "alpha"}
  ];

  assert.deepEqual(
    customersByName(customers, "en").map(customer => customer.id),
    ["alpha", "alpha-equal", "beta", "two", "ten", "blank"]
  );
  assert.deepEqual(
    customers.map(customer => customer.id),
    ["blank", "ten", "beta", "two", "alpha", "alpha-equal"]
  );
});
