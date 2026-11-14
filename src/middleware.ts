import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database, UserRole } from "@/types/database.types";
import { WORKSPACE_COOKIE, isWorkspaceMode } from "@/lib/auth/workspace-constants";

const PUBLIC_PATHS = ["/login", "/auth/callback"];
const SELECT_WORKSPACE_PATH = "/select-workspace";

function supabaseConfig() {
  const testUrl = process.env.TEST_SUPABASE_URL;
  if (testUrl) {
    const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
    if (!anonKey) throw new Error("SLA test Supabase is partially configured; refusing Production fallback.");
    return { url: testUrl, anonKey };
  }
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  };
}

function roleHome(role: UserRole, workspace: string | undefined): string {
  if (role === "admin") {
    return isWorkspaceMode(workspace) ? (workspace === "admin" ? "/admin" : "/collector") : SELECT_WORKSPACE_PATH;
  }
  return "/collector";
}

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const config = supabaseConfig();

  const supabase = createServerClient<Database>(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request: { headers: requestHeaders } });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;
  const isPublicPath = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!user) {
    if (isPublicPath || pathname === "/") return response;
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, deleted_at, suspended_at")
    .eq("id", user.id)
    .single();

  if (!profile) return NextResponse.redirect(new URL("/login", request.url));

  const role: UserRole = profile.role;
  const workspace = request.cookies.get(WORKSPACE_COOKIE)?.value;
  const home = roleHome(role, workspace);

  if (isPublicPath || pathname === "/") return NextResponse.redirect(new URL(home, request.url));
  if (pathname.startsWith(SELECT_WORKSPACE_PATH)) {
    if (role !== "admin") return NextResponse.redirect(new URL(home, request.url));
    return response;
  }
  if (pathname.startsWith("/admin") && role !== "admin") return NextResponse.redirect(new URL(home, request.url));
  if (pathname.startsWith("/collector") && role !== "collector" && role !== "admin") return NextResponse.redirect(new URL(home, request.url));
  if (role === "collector" && (profile.deleted_at || profile.suspended_at) && pathname !== "/collector/suspended") {
    return NextResponse.redirect(new URL("/collector/suspended", request.url));
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api/cron|_next/static|_next/image|favicon.ico|sw\\.js|.*\\.(?:svg|png|jpg|jpeg|webp)$).*)",
  ],
};
