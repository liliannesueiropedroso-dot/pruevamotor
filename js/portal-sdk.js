(function () {
  var TARGET = "playgama";
  var initialized = false;
  var playing = false;

  async function init() {
    if (initialized) return;
    initialized = true;
    try {
      if (TARGET === 'poki' && window.PokiSDK) {
        await window.PokiSDK.init();
      } else if (TARGET === 'crazygames' && window.CrazyGames && window.CrazyGames.SDK) {
        await window.CrazyGames.SDK.init();
        if (window.CrazyGames.SDK.game && window.CrazyGames.SDK.game.loadingStart) {
          window.CrazyGames.SDK.game.loadingStart();
        }
      } else if (TARGET === 'playgama' && window.bridge) {
        await window.bridge.initialize();
      }
    } catch (err) {
      console.warn('[NexusPortal] SDK fallback activo:', err);
    }
  }

  function loadingFinished() {
    try {
      if (TARGET === 'poki' && window.PokiSDK && window.PokiSDK.gameLoadingFinished) {
        window.PokiSDK.gameLoadingFinished();
      } else if (TARGET === 'crazygames' && window.CrazyGames && window.CrazyGames.SDK && window.CrazyGames.SDK.game) {
        window.CrazyGames.SDK.game.loadingStop();
      } else if (TARGET === 'playgama' && window.bridge && window.bridge.platform) {
        window.bridge.platform.sendMessage('game_ready');
      }
    } catch (err) {
      console.warn('[NexusPortal] loadingFinished:', err);
    }
  }

  function gameplayStart() {
    if (playing) return;
    playing = true;
    try {
      if (TARGET === 'poki' && window.PokiSDK && window.PokiSDK.gameplayStart) {
        window.PokiSDK.gameplayStart();
      } else if (TARGET === 'crazygames' && window.CrazyGames && window.CrazyGames.SDK && window.CrazyGames.SDK.game) {
        window.CrazyGames.SDK.game.gameplayStart();
      }
    } catch (err) {
      console.warn('[NexusPortal] gameplayStart:', err);
    }
  }

  function gameplayStop() {
    if (!playing) return;
    playing = false;
    try {
      if (TARGET === 'poki' && window.PokiSDK && window.PokiSDK.gameplayStop) {
        window.PokiSDK.gameplayStop();
      } else if (TARGET === 'crazygames' && window.CrazyGames && window.CrazyGames.SDK && window.CrazyGames.SDK.game) {
        window.CrazyGames.SDK.game.gameplayStop();
      }
    } catch (err) {
      console.warn('[NexusPortal] gameplayStop:', err);
    }
  }

  async function showAd() {
    gameplayStop();
    try {
      if (TARGET === 'poki' && window.PokiSDK && window.PokiSDK.commercialBreak) {
        await window.PokiSDK.commercialBreak();
      } else if (TARGET === 'crazygames' && window.CrazyGames && window.CrazyGames.SDK && window.CrazyGames.SDK.ad) {
        await window.CrazyGames.SDK.ad.requestAd('midgame');
      } else if (TARGET === 'playgama' && window.bridge && window.bridge.advertisement) {
        await window.bridge.advertisement.showInterstitial();
      }
    } catch (err) {
      console.warn('[NexusPortal] showAd:', err);
    }
    gameplayStart();
  }

  window.NexusPortal = {
    target: TARGET,
    init: init,
    loadingFinished: loadingFinished,
    gameplayStart: gameplayStart,
    gameplayStop: gameplayStop,
    showAd: showAd
  };
})();
