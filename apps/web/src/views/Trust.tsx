import { api, type TrustData } from "../api";
import { Feedback, Loading } from "../components/ui";
import { ProfileEditor } from "../settings/ProfileEditor";
import { useResource, useTask } from "../state";
import { PromotionPrompts } from "./PromotionPrompts";
import { TrustPicker } from "./TrustControls";
import { CategoryTable, SafetyForm } from "./TrustSafety";
import { modeLabel } from "./trust-modes";

export { PromotionPrompts } from "./PromotionPrompts";
export { ModeMenu, TrustLadder, TrustPicker } from "./TrustControls";
export { modeLabel, modes } from "./trust-modes";

/** Settings → Trust & rules. */
export function TrustSettings() {
  const { data, error } = useResource<TrustData>("/trust"),
    profile = useResource<{ markdown: string }>("/user-profile"),
    task = useTask();
  if (!data) {
    return error ? <Feedback error={error} /> : <Loading />;
  }
  return (
    <>
      <section className="settings-block">
        <h3>Permission mode</h3>
        <p className="hint">
          The same ladder as a coding agent’s permission picker. It is also in the sidebar and under
          the composer.
        </p>
        <TrustPicker
          value={data.config.globalMode}
          disabled={task.busy}
          onChange={(mode) =>
            task.run(
              () => api.setTrust({ globalMode: mode }),
              `Permission mode set to ${modeLabel(mode)}.`,
            )
          }
        />
        <Feedback error={task.error} />
      </section>
      <PromotionPrompts />
      <CategoryTable data={data} />
      <SafetyForm key={JSON.stringify(data.config)} config={data.config} />
      {profile.data ? (
        <ProfileEditor markdown={profile.data.markdown} />
      ) : (
        <Feedback error={profile.error} />
      )}
    </>
  );
}
