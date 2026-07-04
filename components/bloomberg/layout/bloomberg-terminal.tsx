"use client";

import { useAtom } from "jotai";
import { useCallback } from "react";
import {
  activeWatchlistAtom,
  addWatchlistAtom,
  closeConfirmModalAtom,
  confirmAndCloseModalAtom,
  confirmModalPropsAtom,
  isConfirmModalOpenAtom,
  isWatchlistOpenAtom,
  openConfirmModalAtom,
  watchlistsAtom,
} from "../atoms/terminal-ui";
import { defaultFilters, resetFiltersAtom, writableFiltersAtom } from "../atoms/terminal-ui";
import { ConfirmationModal } from "../core/confirmation-modal";
import { ShortcutsHelp } from "../core/keyboard-shortcuts";
import { Watchlist } from "../core/watchlist";
import { useTerminalUI } from "../hooks";
import { useMarketDataQuery } from "../hooks";
import { TerminalFilterBar } from "../layout/terminal-filter-bar";
import { TerminalHeader } from "../layout/terminal-header";
import { TerminalLayout } from "../layout/terminal-layout";
import type { FilterState, MarketItem } from "../types";
import { FleetView } from "../views/fleet-view";
import { IVView } from "../views/iv-view";
import { JackView } from "../views/jack-view";
import MarketMoversView from "../views/market-movers-view";
import { MarketView } from "../views/market-view";
import NewsView from "../views/news-view";
import { RmiView } from "../views/rmi-view";
import VolatilityView from "../views/volatility-view";

export default function BloombergTerminal() {
  const {
    isDarkMode,
    error,
    setError,
    currentView,
    setCurrentView,
    isShortcutsHelpOpen,
    setIsShortcutsHelpOpen,
    handleThemeToggle,
    handleMarketView,
    handleNewsView,
    handleMoversView,
    handleVolatilityView,
    handleRmiView,
    handleFleetView,
    handleIVView,
	handleJackView,
    handleCancelClick,
    handleNewClick,
    handleBlancClick,
    handleHelpClick,
  } = useTerminalUI();

  const [isConfirmModalOpen, setIsConfirmModalOpen] = useAtom(isConfirmModalOpenAtom);
  const [confirmModalProps, setConfirmModalProps] = useAtom(confirmModalPropsAtom);
  const [isWatchlistOpen, setIsWatchlistOpen] = useAtom(isWatchlistOpenAtom);
  const [watchlists, setWatchlists] = useAtom(watchlistsAtom);
  const [activeWatchlist, setActiveWatchlist] = useAtom(activeWatchlistAtom);
  const [filters, setFilters] = useAtom(writableFiltersAtom);
  const [, resetFilters] = useAtom(resetFiltersAtom);

  const [, openConfirmModal] = useAtom(openConfirmModalAtom);
  const [, closeConfirmModal] = useAtom(closeConfirmModalAtom);
  const [, confirmAndCloseModal] = useAtom(confirmAndCloseModalAtom);
  const [, addWatchlist] = useAtom(addWatchlistAtom);

  const { marketData: data, refreshData, toggleRealTimeUpdates, isLoading } = useMarketDataQuery();

  const allMarketIndices = useCallback(() => {
    const indices: string[] = [];
    if (data?.americas) {
      for (const item of data.americas) {
        indices.push(item.id);
      }
    }
    if (data?.emea) {
      for (const item of data.emea) {
        indices.push(item.id);
      }
    }
    if (data?.asiaPacific) {
      for (const item of data.asiaPacific) {
        indices.push(item.id);
      }
    }
    return indices;
  }, [data]);

  const handleCancelWithConfirm = () => {
    openConfirmModal({
      title: "Confirm Action",
      message: "Are you sure you want to cancel the current operation?",
      onConfirm: () => {
        console.log("Operation cancelled");
      },
    });
  };

  const handleNewWatchlist = () => {
    setIsWatchlistOpen(true);
  };

  const handleBlancWithConfirm = () => {
    openConfirmModal({
      title: "Clear All Filters",
      message: "Are you sure you want to reset all filters to default?",
      onConfirm: () => {
        resetFilters();
        console.log("Filters reset to default");
      },
    });
  };

  const handleBackFromView = () => {
    setCurrentView("market");
  };

  const handleWatchlistSave = (watchlist: { name: string; indices: string[] }) => {
    addWatchlist(watchlist);
  };

  const shortcuts = [
    { key: "n", ctrlKey: true, action: handleNewWatchlist, description: "Create new watchlist" },
    { key: "b", ctrlKey: true, action: handleBlancWithConfirm, description: "Reset all filters" },
    { key: "Escape", action: handleCancelWithConfirm, description: "Cancel current operation" },
    { key: "r", ctrlKey: true, action: refreshData, description: "Refresh data" },
    { key: "l", ctrlKey: true, action: toggleRealTimeUpdates, description: "Toggle live updates" },
    { key: "1", action: handleMarketView, description: "Show market view" },
    { key: "2", action: handleNewsView, description: "Show news view" },
    { key: "3", action: handleMoversView, description: "Show market movers" },
    { key: "4", action: handleVolatilityView, description: "Show volatility view" },
    { key: "5", action: handleFleetView, description: "Show fleet monitor" },
    { key: "6", action: handleIVView, description: "Show IV regime + options signal" },
	{ key: "7", action: handleJackView, description: "Show JACK swing setup validation" },
    { key: "?", action: handleHelpClick, description: "Show keyboard shortcuts" },
  ];

  if (currentView === "news") {
    return (
      <TerminalLayout shortcuts={shortcuts}>
        <NewsView isDarkMode={isDarkMode} onBack={handleBackFromView} />
      </TerminalLayout>
    );
  }

  if (currentView === "movers") {
    return (
      <TerminalLayout shortcuts={shortcuts}>
        <MarketMoversView
          isDarkMode={isDarkMode}
          onBack={handleBackFromView}
          marketData={data}
          onRefresh={refreshData}
          isLoading={isLoading}
        />
      </TerminalLayout>
    );
  }

  if (currentView === "volatility") {
    return (
      <TerminalLayout shortcuts={shortcuts}>
        <VolatilityView
          isDarkMode={isDarkMode}
          onBack={handleBackFromView}
          marketData={data}
          onRefresh={refreshData}
          isLoading={isLoading}
        />
      </TerminalLayout>
    );
  }

  if (currentView === "rmi") {
    return (
      <TerminalLayout shortcuts={shortcuts}>
        <RmiView />
      </TerminalLayout>
    );
  }

  if (currentView === "fleet") {
    return (
      <TerminalLayout shortcuts={shortcuts}>
        <FleetView isDarkMode={isDarkMode} onBack={handleBackFromView} />
      </TerminalLayout>
    );
  }

  if (currentView === "iv") {
    return (
      <TerminalLayout shortcuts={shortcuts}>
        <IVView isDarkMode={isDarkMode} onBack={handleBackFromView} />
      </TerminalLayout>
    );
  }
  
  if (currentView === "jack") {
    return (
      <TerminalLayout shortcuts={shortcuts}>
        <JackView isDarkMode={isDarkMode} onBack={handleBackFromView} />
      </TerminalLayout>
    );
  }

  return (
    <TerminalLayout shortcuts={shortcuts}>
      <TerminalHeader
        isDarkMode={isDarkMode}
        onCancelClick={handleCancelWithConfirm}
        onNewClick={handleNewWatchlist}
        onBlancClick={handleBlancWithConfirm}
        onNewsClick={handleNewsView}
        onMoversClick={handleMoversView}
        onVolatilityClick={handleVolatilityView}
        onRmiClick={handleRmiView}
        onFleetClick={handleFleetView}
        onIVClick={handleIVView}
		onJackClick={handleJackView}
        onHelpClick={handleHelpClick}
        onThemeToggle={handleThemeToggle}
      />

      <TerminalFilterBar isDarkMode={isDarkMode} watchlists={watchlists} />

      <MarketView isDarkMode={isDarkMode} />

      <ConfirmationModal
        isOpen={isConfirmModalOpen}
        onClose={closeConfirmModal}
        onConfirm={confirmAndCloseModal}
        title={confirmModalProps.title}
        message={confirmModalProps.message}
        isDarkMode={isDarkMode}
      />

      <Watchlist
        isOpen={isWatchlistOpen}
        onClose={() => setIsWatchlistOpen(false)}
        isDarkMode={isDarkMode}
        marketIndices={allMarketIndices()}
        onSave={handleWatchlistSave}
      />

      <ShortcutsHelp
        shortcuts={shortcuts}
        isOpen={isShortcutsHelpOpen}
        onClose={() => setIsShortcutsHelpOpen(false)}
        isDarkMode={isDarkMode}
      />
    </TerminalLayout>
  );
}
