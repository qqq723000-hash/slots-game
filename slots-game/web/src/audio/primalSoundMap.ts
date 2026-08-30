const SAMPLE_RATE = 44_100;

export const PRIMAL_AUDIO_PACKS = Object.freeze({
  sounds0: "sounds_desktop_0.m4a",
  sounds1: "sounds_desktop_1.m4a",
  sounds2: "sounds_desktop_2.m4a",
  delayed: "snd_delayed_desktop_0.m4a",
  common: "common_sounds_desktop.mp3",
} as const);

export type PrimalAudioPackId = keyof typeof PRIMAL_AUDIO_PACKS;

export interface PrimalSpriteCueDefinition {
  readonly pack: PrimalAudioPackId;
  readonly startSample: number;
  readonly endSample: number;
  readonly loopStartSample?: number;
  readonly loopEndSample?: number;
}

/**
 * 根据捕获的 44.1 kHz 桌面精灵清单进行验证。保留整数样本位置可以避免复制的小数偏移造成的时间漂移​​。
 *
 * 英文 / English: Verified against captured 44.1 kHz desktop sprite manifest. Preserving integer sample positions avoids time drift caused by copied fractional offsets.
 */
export const PRIMAL_CUE_DEFINITIONS = Object.freeze({
  "1065MusBgLvl1": { pack: "sounds0", startSample: 44_100, endSample: 2_469_600 },
  "1065MusBgLvl2": { pack: "sounds0", startSample: 2_491_650, endSample: 4_917_150 },
  "1065MusBw": { pack: "sounds0", startSample: 4_939_200, endSample: 5_544_000 },
  "1065MusBwEnd": { pack: "sounds0", startSample: 5_578_650, endSample: 5_805_450 },
  "1065MusFs": { pack: "sounds0", startSample: 5_865_300, endSample: 8_055_093 },
  "1065MusFsEnd": { pack: "sounds0", startSample: 8_092_350, endSample: 8_457_316 },
  "743SpinsLoop1of3": { pack: "sounds0", startSample: 8_511_300, endSample: 8_675_940 },
  "743SpinsLoop2of3": { pack: "sounds0", startSample: 8_709_750, endSample: 8_874_390 },
  "743SpinsLoop3of3": { pack: "sounds0", startSample: 8_908_200, endSample: 9_072_840 },
  "743SpinsStop1of5": { pack: "sounds0", startSample: 9_106_650, endSample: 9_163_980 },
  "743SpinsStop2of5": { pack: "sounds0", startSample: 9_216_900, endSample: 9_274_230 },
  "743SpinsStop3of5": { pack: "sounds0", startSample: 9_327_150, endSample: 9_384_480 },
  "743SpinsStop4of5": { pack: "sounds0", startSample: 9_437_400, endSample: 9_494_730 },
  "1065TrnFsIntro": { pack: "sounds0", startSample: 9_547_650, endSample: 9_652_984 },
  "1065TrnFsOutroPanel": { pack: "sounds0", startSample: 9_702_000, endSample: 9_836_680 },
  "1065TrnGameIntro": { pack: "sounds0", startSample: 9_900_450, endSample: 10_345_251 },
  "1065TrnWheelPanel": { pack: "sounds0", startSample: 10_407_600, endSample: 10_545_762 },

  "743SpinsStop5of5": { pack: "sounds1", startSample: 44_100, endSample: 101_430 },
  "743UiClose": { pack: "sounds1", startSample: 154_350, endSample: 248_430 },
  "743UiInteract1of3": { pack: "sounds1", startSample: 308_700, endSample: 366_030 },
  "743UiInteract2of3": { pack: "sounds1", startSample: 418_950, endSample: 476_280 },
  "743UiInteract3of3": { pack: "sounds1", startSample: 529_200, endSample: 586_530 },
  // 捕获的仅清单提示：当前的官方捆绑包不为其调度任何操作。 / English: Caught manifest-only tip: The current official bundle has no operations scheduled for it.
  "743UiLight": { pack: "sounds1", startSample: 639_450, endSample: 728_385 },
  "743UiOpen": { pack: "sounds1", startSample: 793_800, endSample: 887_880 },
  "743UiSpin1of3": { pack: "sounds1", startSample: 948_150, endSample: 1_022_385 },
  "743UiSpin2of3": { pack: "sounds1", startSample: 1_058_400, endSample: 1_132_635 },
  "743UiSpin3of3": { pack: "sounds1", startSample: 1_168_650, endSample: 1_242_885 },
  "965SpinsWaitFire1of3": { pack: "sounds1", startSample: 1_278_900, endSample: 1_617_184 },
  "965SpinsWaitFire2of3": { pack: "sounds1", startSample: 1_653_750, endSample: 1_986_175 },
  "965SpinsWaitFire3of3": { pack: "sounds1", startSample: 2_028_600, endSample: 2_304_976 },
  "1065BigWinRoar1of2": { pack: "sounds1", startSample: 2_359_350, endSample: 2_491_838 },
  "1065BigWinRoar2of2": { pack: "sounds1", startSample: 2_557_800, endSample: 2_760_972 },
  // 延迟的捆绑包最后加载并覆盖这些重复的标题密钥。 / English: Delayed bundles load last and overwrite these duplicate title keys.
  "BigWinCounterGenericNewLoop1": { pack: "delayed", startSample: 44_100, endSample: 143_290 },
  "BigWinCounterGenericNewStart1": { pack: "delayed", startSample: 198_450, endSample: 267_562 },
  "BigWinCounterGenericNewTail1": { pack: "delayed", startSample: 308_700, endSample: 395_858 },
  "BigWinCounterSweetener1": { pack: "delayed", startSample: 418_950, endSample: 443_306 },
  "BigWinCounterSweetener2": { pack: "delayed", startSample: 485_100, endSample: 511_250 },
  "BigWinCounterSweetener3": { pack: "delayed", startSample: 551_250, endSample: 622_888 },
  "BigWinCounterSweetener4": { pack: "delayed", startSample: 661_500, endSample: 735_531 },
  "BigWinCounterSweetener5": { pack: "delayed", startSample: 771_750, endSample: 823_279 },
  "WinCounterGenericNewLoop1": { pack: "delayed", startSample: 882_000, endSample: 900_148 },
  "WinCounterGenericNewStart1": { pack: "delayed", startSample: 948_150, endSample: 1_020_832 },
  "WinCounterGenericNewTail1": { pack: "delayed", startSample: 1_058_400, endSample: 1_135_790 },
  "WinCounterSweetener1": { pack: "delayed", startSample: 1_168_650, endSample: 1_191_823 },
  "WinCounterSweetener2": { pack: "delayed", startSample: 1_234_800, endSample: 1_260_953 },
  "WinCounterSweetener3": { pack: "delayed", startSample: 1_300_950, endSample: 1_326_453 },
  "WinCounterSweetener4": { pack: "delayed", startSample: 1_367_100, endSample: 1_380_242 },
  // 长/短切片被捕获，但在该游戏的 SoundStage 中没有标题参考。 / English: Long/short slices are captured, but there is no title reference in the SoundStage for that game.
  "LandBasedJackpotLong": { pack: "sounds1", startSample: 3_638_250, endSample: 3_906_405 },
  "LandBasedJackpotMed": { pack: "sounds1", startSample: 3_969_000, endSample: 4_171_297 },
  "LandBasedJackpotShort": { pack: "sounds1", startSample: 4_211_550, endSample: 4_327_992 },
  "986Win2x": { pack: "sounds1", startSample: 4_365_900, endSample: 4_556_619 },
  "986Win3x": { pack: "sounds1", startSample: 4_608_450, endSample: 4_811_936 },
  "986Win4x": { pack: "sounds1", startSample: 4_851_000, endSample: 5_054_954 },
  "986Win5x": { pack: "sounds1", startSample: 5_093_550, endSample: 5_307_020 },
  "986Win6x": { pack: "sounds1", startSample: 5_336_100, endSample: 5_591_510 },
  "986Win7x": { pack: "sounds1", startSample: 5_622_750, endSample: 5_878_161 },
  "986Win8x": { pack: "sounds1", startSample: 5_909_400, endSample: 6_278_712 },
  "986WinLessThanBet": { pack: "sounds1", startSample: 6_328_350, endSample: 6_479_589 },
  "1065ScatterLand1of5": { pack: "sounds1", startSample: 7_078_050, endSample: 7_092_656 },
  "1065ScatterLand2of5": { pack: "sounds1", startSample: 7_144_200, endSample: 7_193_299 },
  "1065ScatterLand3of5": { pack: "sounds1", startSample: 7_254_450, endSample: 7_303_930 },
  "1065ScatterLand4of5": { pack: "sounds1", startSample: 7_364_700, endSample: 7_413_864 },
  "1065ScatterLand5of5": { pack: "sounds1", startSample: 7_474_950, endSample: 7_523_377 },
  "1065SymHp1Win": { pack: "sounds1", startSample: 7_585_200, endSample: 7_697_958 },
  "1065SymHp2Win": { pack: "sounds1", startSample: 7_739_550, endSample: 7_824_279 },
  "1065SymLp1Win": { pack: "sounds1", startSample: 7_849_800, endSample: 7_882_278 },
  "1065SymLp2Win": { pack: "sounds1", startSample: 7_915_950, endSample: 7_947_375 },
  "1065SymMp1Win": { pack: "sounds1", startSample: 7_982_100, endSample: 8_022_060 },
  "1065SymMp2Win": { pack: "sounds1", startSample: 8_048_250, endSample: 8_108_044 },
  "1065SymRageCollect": { pack: "sounds1", startSample: 8_158_500, endSample: 8_281_849 },
  "1065SfGrandPot": { pack: "sounds1", startSample: 8_312_850, endSample: 8_586_985 },
  "1065SfMajorPot": { pack: "sounds1", startSample: 8_643_600, endSample: 8_798_546 },
  "1065SfMegaPot": { pack: "sounds1", startSample: 8_842_050, endSample: 9_056_590 },
  "1065SfMiniPot": { pack: "sounds1", startSample: 9_084_600, endSample: 9_215_708 },
  "1065SfMinorPot": { pack: "sounds1", startSample: 9_238_950, endSample: 9_381_977 },
  "1065SfPpsLvl2": { pack: "sounds1", startSample: 9_437_400, endSample: 9_622_305 },
  "1065SfPpsLvl3": { pack: "sounds1", startSample: 9_679_950, endSample: 9_831_540 },
  "1065SfPpsLvl4": { pack: "sounds1", startSample: 9_878_400, endSample: 10_081_795 },
  "1065SfPpsLvl5": { pack: "sounds1", startSample: 10_120_950, endSample: 10_321_514 },
  "1065SfRoar1of5": { pack: "sounds1", startSample: 10_363_500, endSample: 10_578_041 },

  "1065SfRoar2of5": { pack: "sounds2", startSample: 44_100, endSample: 258_641 },
  "1065SfRoar3of5": { pack: "sounds2", startSample: 286_650, endSample: 501_191 },
  "1065SfRoar4of5": { pack: "sounds2", startSample: 529_200, endSample: 743_741 },
  "1065SfRoar5of5": { pack: "sounds2", startSample: 771_750, endSample: 986_291 },
  "1065SfRoarHit1of5": { pack: "sounds2", startSample: 1_014_300, endSample: 1_192_347 },
  "1065SfRoarHit2of5": { pack: "sounds2", startSample: 1_256_850, endSample: 1_472_407 },
  "1065SfRoarHit3of5": { pack: "sounds2", startSample: 1_499_400, endSample: 1_714_957 },
  "1065SfRoarHit4of5": { pack: "sounds2", startSample: 1_741_950, endSample: 1_957_507 },
  "1065SfRoarHit5of5": { pack: "sounds2", startSample: 1_984_500, endSample: 2_200_057 },
  "1065SfSniff1of3": { pack: "sounds2", startSample: 2_227_050, endSample: 2_375_562 },
  "1065SfSniff2of3": { pack: "sounds2", startSample: 2_425_500, endSample: 2_574_012 },
  "1065SfSniff3of3": { pack: "sounds2", startSample: 2_623_950, endSample: 2_772_462 },
  "1065SfThump1of3": { pack: "sounds2", startSample: 2_822_400, endSample: 3_017_050 },
  "1065SfThump2of3": { pack: "sounds2", startSample: 3_064_950, endSample: 3_259_600 },
  "1065SfThump3of3": { pack: "sounds2", startSample: 3_307_500, endSample: 3_504_815 },
  "1065SfThumpExpand1of3": { pack: "sounds2", startSample: 3_550_050, endSample: 3_679_677 },
  "1065SfThumpExpand2of3": { pack: "sounds2", startSample: 3_704_400, endSample: 3_834_027 },
  "1065SfThumpExpand3of3": { pack: "sounds2", startSample: 3_858_750, endSample: 3_988_377 },
  "1065SfWheelAppear": { pack: "sounds2", startSample: 4_013_100, endSample: 4_200_116 },
  "1065SfWheelAward": { pack: "sounds2", startSample: 4_255_650, endSample: 4_406_977 },
  "1065SfWheelSpin": { pack: "sounds2", startSample: 4_454_100, endSample: 4_873_619 },
  "1065SfWheelWait": { pack: "sounds2", startSample: 4_917_150, endSample: 5_055_087 },

  "wincounter_loop": {
    pack: "common",
    startSample: 44_100,
    endSample: 92_955,
    loopStartSample: 51_315,
    loopEndSample: 58_530,
  },
  "btnClick": { pack: "common", startSample: 137_055, endSample: 158_624 },
  // 捕获共同精灵提示；目前没有官方调度员引用它。 / English: Capture co-elf tip; no official dispatcher currently references it.
  "GenericWinLessSnd": { pack: "common", startSample: 202_724, endSample: 233_837 },
} as const satisfies Readonly<Record<string, PrimalSpriteCueDefinition>>);

export type PrimalSpriteCueName = keyof typeof PRIMAL_CUE_DEFINITIONS;

export const PRIMAL_UI_INTERACT_CUES = Object.freeze([
  "743UiInteract1of3",
  "743UiInteract2of3",
  "743UiInteract3of3",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_UI_SPIN_CUES = Object.freeze([
  "743UiSpin1of3",
  "743UiSpin2of3",
  "743UiSpin3of3",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_REEL_LOOP_CUES = Object.freeze([
  "743SpinsLoop1of3",
  "743SpinsLoop2of3",
  "743SpinsLoop3of3",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_REEL_STOP_CUES = Object.freeze([
  "743SpinsStop1of5",
  "743SpinsStop2of5",
  "743SpinsStop3of5",
  "743SpinsStop4of5",
  "743SpinsStop5of5",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_REEL_ANTICIPATION_CUES = Object.freeze([
  "965SpinsWaitFire1of3",
  "965SpinsWaitFire2of3",
  "965SpinsWaitFire3of3",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_SCATTER_LAND_CUES = Object.freeze([
  "1065ScatterLand1of5",
  "1065ScatterLand2of5",
  "1065ScatterLand3of5",
  "1065ScatterLand4of5",
  "1065ScatterLand5of5",
] as const satisfies readonly PrimalSpriteCueName[]);

/** 第一级故意在捕获的声场数据中重复使用 PpsLvl2。 / English: The first stage intentionally reuses PpsLvl2 in the captured sound field data. */
export const PRIMAL_PPS_LEVEL_CUES = Object.freeze([
  "1065SfPpsLvl2",
  "1065SfPpsLvl2",
  "1065SfPpsLvl3",
  "1065SfPpsLvl4",
  "1065SfPpsLvl5",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_JACKPOT_POT_CUES = Object.freeze({
  mini: "1065SfMiniPot",
  minor: "1065SfMinorPot",
  major: "1065SfMajorPot",
  mega: "1065SfMegaPot",
  grand: "1065SfGrandPot",
} as const satisfies Readonly<Record<string, PrimalSpriteCueName>>);

/** 即使在庆祝模式下，Win1 也是用小于投注额的样本预设的。 / English: Even in celebration mode, Win1 is preset with samples smaller than the stake. */
export const PRIMAL_PAYOUT_WIN_CUES = Object.freeze([
  "986WinLessThanBet",
  "986Win2x",
  "986Win3x",
  "986Win4x",
  "986Win5x",
  "986Win6x",
  "986Win7x",
  "986Win8x",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_RAGE_ROAR_CUES = Object.freeze([
  "1065SfRoar1of5",
  "1065SfRoar3of5",
  "1065SfRoar2of5",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_BIG_WIN_LEVEL_CUES = Object.freeze([
  "1065SfRoar1of5",
  "1065SfRoar2of5",
  "1065SfRoar3of5",
  "1065SfRoar4of5",
  "1065SfRoar5of5",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_BIG_WIN_END_ROARS = Object.freeze([
  "1065BigWinRoar1of2",
  "1065BigWinRoar2of2",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_BIG_WIN_COUNTER_SWEETENERS = Object.freeze([
  "BigWinCounterSweetener1",
  "BigWinCounterSweetener2",
  "BigWinCounterSweetener3",
  "BigWinCounterSweetener4",
  "BigWinCounterSweetener5",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_NORMAL_WIN_COUNTER_SWEETENERS = Object.freeze([
  "WinCounterSweetener1",
  "WinCounterSweetener2",
  "WinCounterSweetener3",
  "WinCounterSweetener4",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_ROAR_CUES = Object.freeze([
  "1065SfRoar1of5",
  "1065SfRoar2of5",
  "1065SfRoar3of5",
  "1065SfRoar4of5",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_ROAR_HIT_CUES = Object.freeze([
  "1065SfRoarHit1of5",
  "1065SfRoarHit2of5",
  "1065SfRoarHit4of5",
  "1065SfRoarHit5of5",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_SNIFF_CUES = Object.freeze([
  "1065SfSniff1of3",
  "1065SfSniff2of3",
  "1065SfSniff3of3",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_THUMP_CUES = Object.freeze([
  "1065SfThump1of3",
  "1065SfThump2of3",
  "1065SfThump3of3",
] as const satisfies readonly PrimalSpriteCueName[]);

export const PRIMAL_THUMP_EXPAND_CUES = Object.freeze([
  "1065SfThumpExpand1of3",
  "1065SfThumpExpand2of3",
  "1065SfThumpExpand3of3",
] as const satisfies readonly PrimalSpriteCueName[]);

export function primalSampleTime(sample: number): number {
  return sample / SAMPLE_RATE;
}
