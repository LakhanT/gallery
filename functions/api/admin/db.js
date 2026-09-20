import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function onRequestGet(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const url = new URL(context.request.url);
    const table = url.searchParams.get("table");
    const format = (url.searchParams.get("format") || "").toLowerCase();

    if (table && (format === "csv" || url.searchParams.get("download") === "1")) {
      const exported = await store.exportTableCsv(table);
      return new Response(exported.csv || "", {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exported.table}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (table) {
      const exported = await store.exportTableCsv(table);
      return jsonResponse(exported);
    }

    return jsonResponse({ tables: await store.listDbTables() });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const body = await readJson(context.request);
    const result = await store.runAdminSql(body.sql);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
