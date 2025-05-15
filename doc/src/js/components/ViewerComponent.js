/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import React from 'react';
import {accessToken, mapboxAccessToken} from '../../../.access-token/token';

import styles from './viewer.module.css';

export class ViewerComponent extends React.Component {
  constructor(props) {
    super(props);
    this.containerRef = React.createRef();
    this.viewerRef = React.createRef();
  }

  componentDidMount() {
    const {init} = this.props;
    this.viewerRef.current = init({
      accessToken,
      mapboxAccessToken,
      container: this.containerRef.current,
    });
  }

  componentWillUnmount() {
    const {dispose} = this.props;
    dispose();
  }

  handleReset = () => {
    if (this.viewerRef.current) {
      this.viewerRef.current.moveTo(0);
    }
  };

  render() {
    const {style} = this.props;
    return (
      <div style={{position: 'relative'}}>
        <div
          ref={this.containerRef}
          className={styles.mapillaryViewer}
          style={style ?? {}}
        />
        <button
          onClick={this.handleReset}
          style={{
            position: 'absolute',
            bottom: '20px',
            right: '20px',
            zIndex: 1000,
            padding: '8px 16px',
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            cursor: 'pointer',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
          }}
        >
          初期位置に戻す
        </button>
      </div>
    );
  }
}
