import type {
  ChartSpec,
  EditOp,
  EditStep,
  ExecutionTurn,
  HtmlPreviewResponse,
  ImageAttachment,
  PublicAccountLogin,
  PublicProviderPreset,
  SessionPage,
  SessionPageInfo,
  SessionReviewInput,
  SessionUsageState,
  SlashCommand,
  TaskPage,
  TranscriptSnapshot,
} from "@forge/core/shared";
import { expectTypeOf, it } from "vitest";

it("exposes client types through the shared module entry", () => {
  expectTypeOf<
    [
      ChartSpec,
      EditOp,
      EditStep,
      ExecutionTurn,
      HtmlPreviewResponse,
      ImageAttachment,
      PublicAccountLogin,
      PublicProviderPreset,
      SessionPage,
      SessionPageInfo,
      SessionReviewInput,
      SessionUsageState,
      SlashCommand,
      TaskPage,
      TranscriptSnapshot,
    ]
  >().not.toBeAny();
});
