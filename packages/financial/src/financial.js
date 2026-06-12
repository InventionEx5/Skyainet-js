// packages/financial/src/financial.js
// =====================================================
// Financial Package — Point d'entrée central
// Treasury + Liquidity
// SkyAInet × Nikola T369
// =====================================================

"use strict";

// ─────────────────────────────────────────────────────────────────
// TREASURY — Distribution SKY + Score éthique on-chain
// ─────────────────────────────────────────────────────────────────

export { TreasuryManager, TreasuryError }             from './treasury.js';

// ─────────────────────────────────────────────────────────────────
// LIQUIDITY — Gestion Uniswap V4 + Slippage protection
// ─────────────────────────────────────────────────────────────────

export { LiquidityManager, LiquidityPosition, LiquidityError } from './liquidity.js';

// ─────────────────────────────────────────────────────────────────
// WALLET — Wallet ERC-20 SKY Token utilisateur
// ─────────────────────────────────────────────────────────────────

export { SkyWallet, WalletTransaction, WalletError } from './wallet.js';

// ─────────────────────────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

export const PACKAGE_INFO = Object.freeze({
  name       : '@skyainet/financial',
  version    : VERSION,
  description: 'SkyAInet Financial — Treasury (15% Burn | 55% Users | 25% DAO | 5% Dev) + Liquidity Uniswap V4',
  modules    : ['TreasuryManager', 'LiquidityManager'],
});
