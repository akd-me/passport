import type { AccountData } from "../api";
import { useResource } from "../state";
import { Loading } from "../components/ui";
import { Navigate } from "react-router";
import { Decisions } from "../views/Decisions";

export function StartPage() {
  const { data } = useResource<AccountData>("/accounts");
  if (!data) return <Loading />;
  return data.accounts.length ? (
    <Decisions />
  ) : (
    <Navigate to="/accounts" replace />
  );
}
