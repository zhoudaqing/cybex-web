import alt from "alt-instance";

class SettingsActions {

    changeSetting(value) {
        return value;
    }

    changeViewSetting(value) {
        return value;
    }

    changeMarketDirection(value) {
        return value;
    }

    addStarMarket(quote, base) {
        return {quote, base};
    }

    removeStarMarket(quote, base) {
        return {quote, base};
    }

    setUserMarket(quote, base, value) {
        return {quote, base, value};
    }

    addWS(ws) {
        return ws;
    }

    removeWS(index) {
        return index;
    }

    hideAsset(id, status) {

        return {id, status};
    }

    toggleNav(value) {
        return value;
    }

    clearSettings() {
        return (dispatch) => {
            return new Promise((resolve) => {
                dispatch(resolve);
            });
        };
    }

    updateLatencies(latencies) {
        return latencies;
    }
}

export default alt.createActions(SettingsActions);
