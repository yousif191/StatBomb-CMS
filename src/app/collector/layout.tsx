import { redirect } from "next/navigation";
import { AppShell, type NavItem } from "@/components/AppShell";
import { getProfileOrRedirect } from "@/lib/auth/getProfile";
import { getSlaAlertItems } from "@/lib/assignments/sla-alert-queries";
import { createClient } from "@/lib/supabase/server";

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/collector" },
  { label: "Tracking Analysis", href: "/collector/tracking-analysis" },
  { label: "My Teammates", href: "/collector/teammates" },
  { label: "My Deductions", href: "/collector/deductions" },
  { label: "My FF Shots", href: "/collector/ff-shots" },
  { label: "Bonus", href: "/collector/bonus" },
  { label: "Expected", href: "/collector/expected" },
  { label: "My Over Target", href: "/collector/over-target" },
  { label: "My Scorecard", href: "/collector/scorecard" },
  { label: "Links", href: "/collector/links" },
  { label: "Account Settings", href: "/collector/settings" },
];

export default async function CollectorLayout({ children }: { children: React.ReactNode }) {
  const profile = await getProfileOrRedirect();
  if (profile.role !== "collector" && profile.role !== "admin") redirect("/admin");
  if (profile.deleted_at || profile.suspended_at) return children;

  const supabase = createClient();
  const slaAlertAssignments = await getSlaAlertItems(supabase, "collector");

  return (
    <AppShell
      roleLabel="Collector"
      userLabel={profile.full_name ?? profile.email}
      navItems={NAV_ITEMS}
      role="collector"
      canSwitchWorkspace={profile.role === "admin"}
      profileId={profile.id}
      slaAlertAssignments={slaAlertAssignments}
    >
      {children}
    </AppShell>
  );
}
