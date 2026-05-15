import { useAtom } from "jotai";
import { useCallback } from "react";
import { currentViewAtom, errorAtom, isDarkModeAtom, isShortcutsHelpOpenAtom } from "../atoms";

export function useTerminalUI() {
  const [isDarkMode, setIsDarkMode] = useAtom(isDarkModeAtom);
  const [error, setError] = useAtom(errorAtom);
  const [isShortcutsHelpOpen, setIsShortcutsHelpOpen] = useAtom(isShortcutsHelpOpenAtom);
  const [currentView, setCurrentView] = useAtom(currentViewAtom);

  const handleThemeToggle = useCallback(() => {
    setIsDarkMode(!isDarkMode);
  }, [isDarkMode, setIsDarkMode]);

  const handleMarketView = useCallback(() => {
    setCurrentView("market");
  }, [setCurrentView]);

  const handleNewsView = useCallback(() => {
    setCurrentView("news");
  }, [setCurrentView]);

  const handleMoversView = useCallback(() => {
    setCurrentView("movers");
  }, [setCurrentView]);

  const handleVolatilityView = useCallback(() => {
    setCurrentView("volatility");
  }, [setCurrentView]);

  const handleRmiView = useCallback(() => {
    setCurrentView("rmi");
  }, [setCurrentView]);

  const handleFleetView = useCallback(() => {
    setCurrentView("fleet");
  }, [setCurrentView]);

  const handleCancelClick = useCallback(() => {
    console.log("Cancel clicked");
  }, []);

  const handleNewClick = useCallback(() => {
    console.log("New clicked");
  }, []);

  const handleBlancClick = useCallback(() => {
    console.log("Blanc clicked");
  }, []);

  const handleHelpClick = useCallback(() => {
    setIsShortcutsHelpOpen(true);
  }, [setIsShortcutsHelpOpen]);

  const handleCloseShortcutsHelp = useCallback(() => {
    setIsShortcutsHelpOpen(false);
  }, [setIsShortcutsHelpOpen]);

  return {
    isDarkMode,
    error,
    isShortcutsHelpOpen,
    currentView,
    setIsDarkMode,
    setError,
    setIsShortcutsHelpOpen,
    setCurrentView,
    handleThemeToggle,
    handleMarketView,
    handleNewsView,
    handleMoversView,
    handleVolatilityView,
    handleRmiView,
    handleFleetView,
    handleCancelClick,
    handleNewClick,
    handleBlancClick,
    handleHelpClick,
    handleCloseShortcutsHelp,
  };
}