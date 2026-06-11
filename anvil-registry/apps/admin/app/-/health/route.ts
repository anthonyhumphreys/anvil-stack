export async function GET() {
  return Response.json({ ok: true, service: "anvil-admin" });
}
