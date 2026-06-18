/**
 * VI 强类型字段层 (P1.1).
 *
 * 13 modules, one zod schema per file. The `module` literal on each schema
 * matches the existing `RuleType` enum for modules covered by BrandRule
 * (color/font/logo/imagery/layout/graphic + copy_tone → copy). The remaining
 * four modules (channel_size / common_asset / brand_profile / ai_constraint)
 * are exported separately because they live outside `RuleType` and are stored
 * as workspace-level profile modules.
 *
 * Each schema includes `extras: z.record(z.unknown()).optional()` as a
 * forward-compatibility safety valve so brand-side schema deltas don't have
 * to thaw the contracts freeze.
 */
import { z } from "zod";
import { LogoModule } from "./logo";
import { ColorModule } from "./color";
import { FontModule } from "./font";
import { GraphicModule } from "./graphic";
import { ImageryModule } from "./imagery";
import { LayoutModule } from "./layout";
import { ProductModule } from "./product";
import { CopyToneModule } from "./copy_tone";
import { ChannelSizeModule } from "./channel_size";
import {
  ProhibitionModule,
  ProhibitionRule,
  ProhibitionSeverity,
  ProhibitionStatus,
  CreateProhibitionRuleInput,
  UpdateProhibitionRuleInput,
} from "./prohibition";
import { CommonAssetModule } from "./common_asset";
import { BrandProfileModule } from "./brand_profile";
import { AIConstraintModule } from "./ai_constraint";

export {
  LogoModule,
  ColorModule,
  FontModule,
  GraphicModule,
  ImageryModule,
  LayoutModule,
  ProductModule,
  CopyToneModule,
  ChannelSizeModule,
  ProhibitionModule,
  ProhibitionRule,
  ProhibitionSeverity,
  ProhibitionStatus,
  CreateProhibitionRuleInput,
  UpdateProhibitionRuleInput,
  CommonAssetModule,
  BrandProfileModule,
  AIConstraintModule,
};

/**
 * Discriminated union over every VI module — usable on the structured
 * payload of a BrandRule or as a typed validator for forms.
 */
export const VIModule = z.discriminatedUnion("module", [
  LogoModule,
  ColorModule,
  FontModule,
  GraphicModule,
  ImageryModule,
  LayoutModule,
  ProductModule,
  CopyToneModule,
  ChannelSizeModule,
  ProhibitionModule,
  CommonAssetModule,
  BrandProfileModule,
  AIConstraintModule,
]);
export type VIModule = z.infer<typeof VIModule>;

/**
 * Module name → matching contracts schema. Useful for form runtime resolution
 * (e.g. `MODULE_BY_NAME[type].parse(value)`).
 */
export const MODULE_BY_NAME = {
  logo: LogoModule,
  color: ColorModule,
  font: FontModule,
  graphic: GraphicModule,
  imagery: ImageryModule,
  layout: LayoutModule,
  product: ProductModule,
  copy_tone: CopyToneModule,
  channel_size: ChannelSizeModule,
  prohibition: ProhibitionModule,
  common_asset: CommonAssetModule,
  brand_profile: BrandProfileModule,
  ai_constraint: AIConstraintModule,
} as const;

export type ModuleName = keyof typeof MODULE_BY_NAME;

/**
 * Mapping from `RuleType` (existing Prisma enum) → VI module name. Used by
 * the rule forms to pick the right schema given the legacy `type` column.
 */
export const RULE_TYPE_TO_MODULE: Record<string, ModuleName> = {
  color: "color",
  font: "font",
  layout: "layout",
  imagery: "imagery",
  graphic: "graphic",
  copy: "copy_tone",
  logo: "logo",
};
