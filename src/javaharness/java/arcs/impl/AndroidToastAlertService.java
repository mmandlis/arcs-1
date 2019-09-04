package arcs.impl;

import android.content.Context;
import android.widget.Toast;
import arcs.api.AlertService;
import javax.inject.Inject;
import javax.inject.Named;

public class AndroidToastAlertService implements AlertService {

  private Context appContext;

  @Inject
  public AndroidToastAlertService(@Named("AppContext") Context appContext) {
    this.appContext = appContext;
  }

  @Override
  public void alert(String msg) {
    Toast.makeText(appContext, msg, Toast.LENGTH_LONG).show();
  }
}